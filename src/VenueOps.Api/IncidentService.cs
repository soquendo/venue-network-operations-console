using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace VenueOps.Api;

public sealed class IncidentService(IncidentDbContext database, PrometheusClient prometheus, TimeProvider timeProvider)
{
    public async Task<IncidentResponse> CreateAsync(CreateIncidentRequest request, CancellationToken cancellationToken)
    {
        request.Validate();
        await IncidentPersistenceHealthCheck.EnsureReadyAsync(database, cancellationToken);
        var replay = await FindCreationReplayAsync(request, cancellationToken);
        if (replay is not null) return replay;
        Incident incident;
        try
        {
            var capture = await prometheus.GetIncidentMonitoringCaptureAsync(cancellationToken);
            incident = Incident.Create(request, capture, timeProvider.GetUtcNow());
        }
        catch (Exception exception) when (IsCaptureFailure(exception) && !cancellationToken.IsCancellationRequested)
        {
            // A competing request may have committed while this capture failed.
            // One bounded lookup can recover it; never retry capture or wait for it.
            replay = await FindCreationReplayAsync(request, cancellationToken);
            if (replay is not null) return replay;
            throw;
        }
        database.Incidents.Add(incident);
        // EF commits this complete graph in one transaction; monitoring I/O precedes it.
        try { await database.SaveChangesAsync(cancellationToken); }
        catch (DbUpdateException exception) when (exception.InnerException is PostgresException
            { SqlState: PostgresErrorCodes.UniqueViolation, ConstraintName: IncidentDbContext.CreationIndex })
        {
            database.ChangeTracker.Clear();
            replay = await FindCreationReplayAsync(request, cancellationToken);
            if (replay is not null) return replay;
            throw;
        }
        return incident.ToResponse();
    }

    private static bool IsCaptureFailure(Exception exception) => exception is IncidentConditionChangedException
        or IncidentValidationException or PrometheusQueryException or HttpRequestException or OperationCanceledException;

    private async Task<IncidentResponse?> FindCreationReplayAsync(CreateIncidentRequest request, CancellationToken cancellationToken)
    {
        if (request.CreationCommandId is null) return null;
        var incident = await database.Incidents.AsNoTracking().Include(item => item.AccessPoints).AsSingleQuery()
            .SingleOrDefaultAsync(item => item.CreationCommandId == request.CreationCommandId, cancellationToken);
        if (incident is null) return null;
        // Sequence 1 must be read directly: it need not be in the newest detail page.
        var created = await database.Events.AsNoTracking()
            .SingleAsync(entry => entry.IncidentId == incident.Id && entry.Sequence == 1, cancellationToken);
        if (!incident.MatchesCreationIntent(request, created))
            throw new IncidentCreationConflictException("This creation command ID was already used for different creation intent.");
        // Reuse the current, version-fenced detail projection; workflow receipts
        // keep their separate immutable replay contract.
        return await GetAsync(incident.Id, cancellationToken);
    }

    public async Task<IncidentListResponse> ListAsync(IncidentListRequest request, CancellationToken cancellationToken) =>
        IncidentListResponse.Page(await ListQuery(database.Incidents.AsNoTracking(), request).ToArrayAsync(cancellationToken));

    public static IQueryable<IncidentSummary> ListQuery(IQueryable<Incident> incidents, IncidentListRequest request)
    {
        request.Validate();
        if (request.Status is not null) incidents = incidents.Where(item => item.Status == request.Status);
        if (request.Zone is not null) incidents = incidents.Where(item => item.Zone == request.Zone);
        if (request.BeforeId.HasValue) incidents = incidents.Where(item => item.Id < request.BeforeId.Value);
        return incidents.OrderByDescending(item => item.Id).Take(IncidentListRequest.PageSize + 1)
            .Select(item => new IncidentSummary(item.Id, item.Title, item.Status, item.Zone,
                item.ResponderLabel, item.CreatedAtUtc, item.ResolvedAtUtc, item.Version, item.AccessPoints.Count));
    }

    public async Task<IncidentResponse?> GetAsync(long id, CancellationToken cancellationToken, long? beforeEventSequence = null)
    {
        IncidentWorkflow.ValidateCursor(beforeEventSequence);
        var incident = await database.Incidents.AsNoTracking().Include(item => item.AccessPoints).AsSingleQuery()
            .SingleOrDefaultAsync(item => item.Id == id, cancellationToken);
        if (incident is null) return null;
        // Capture current state first. Immutable events committed afterward must not
        // appear ahead of the version represented by this response.
        var capturedVersion = incident.Version;
        var query = database.Events.AsNoTracking().Where(entry => entry.IncidentId == id && entry.Sequence <= capturedVersion);
        if (beforeEventSequence.HasValue) query = query.Where(entry => entry.Sequence < beforeEventSequence.Value);
        var events = await query.OrderByDescending(entry => entry.Sequence).Take(IncidentWorkflow.PageSize + 1)
            .ToArrayAsync(cancellationToken);
        return incident.ToResponse(events, beforeEventSequence);
    }

    public async Task<IncidentCommandReceipt?> ExecuteCommandAsync(long id, IncidentCommand command, CancellationToken cancellationToken)
    {
        var replay = await FindReplayAsync(id, command, cancellationToken);
        if (replay is not null) return replay;
        // No Prometheus call or growing event collection is needed for stored work.
        var incident = await database.Incidents.SingleOrDefaultAsync(item => item.Id == id, cancellationToken);
        if (incident is null) return null;
        if (incident.Version != command.ExpectedVersion)
            return await ResolveRaceAsync(id, command, cancellationToken);
        var entry = incident.Apply(command, timeProvider.GetUtcNow());
        database.Events.Add(entry);
        try
        {
            // The conditional version update and event INSERT share EF's transaction.
            await database.SaveChangesAsync(cancellationToken);
            return entry.ToReceipt();
        }
        catch (Exception exception) when (IsCommandRace(exception))
        {
            // SaveChanges rolled back; never reuse the attempted graph or silently
            // apply the business command against another version.
            return await ResolveRaceAsync(id, command, cancellationToken);
        }
    }

    private async Task<IncidentCommandReceipt?> FindReplayAsync(long id, IncidentCommand command, CancellationToken cancellationToken)
    {
        var entry = await database.Events.AsNoTracking()
            .SingleOrDefaultAsync(item => item.IncidentId == id && item.CommandId == command.CommandId, cancellationToken);
        if (entry is null) return null;
        if (entry.Matches(command)) return entry.ToReceipt();
        var current = await database.Incidents.AsNoTracking().SingleOrDefaultAsync(item => item.Id == id, cancellationToken);
        throw new IncidentWorkflowConflictException("command_conflict", "This command ID was already used for a different action.", current?.Version, current?.Status);
    }

    private async Task<IncidentCommandReceipt?> ResolveRaceAsync(long id, IncidentCommand command, CancellationToken cancellationToken)
    {
        database.ChangeTracker.Clear();
        var replay = await FindReplayAsync(id, command, cancellationToken);
        if (replay is not null) return replay;
        var current = await database.Incidents.AsNoTracking().SingleOrDefaultAsync(item => item.Id == id, cancellationToken);
        if (current is null) return null;
        // Also covers a winner committing between the lookup and current-state read.
        replay = await FindReplayAsync(id, command, cancellationToken);
        if (replay is not null) return replay;
        throw IncidentWorkflow.Conflict(current, "version_conflict", "This incident changed. Review current state before retrying.");
    }

    private static bool IsCommandRace(Exception exception) => exception is DbUpdateConcurrencyException
        || exception is DbUpdateException
        {
            InnerException: PostgresException
            {
                SqlState: PostgresErrorCodes.UniqueViolation,
                ConstraintName: IncidentDbContext.CommandIndex or IncidentDbContext.SequenceIndex
            }
        };
}
