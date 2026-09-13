using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace VenueOps.Api;

public static class IncidentEndpoints
{
    public static void MapIncidentEndpoints(this WebApplication app)
    {
        app.MapGet("/api/incidents", (string? status, string? zone, long? beforeId, IncidentService service, CancellationToken cancellationToken) =>
            ExecuteAsync(async token => Results.Ok(await service.ListAsync(new(status, zone, beforeId), token)), cancellationToken));

        app.MapPost("/api/incidents", (CreateIncidentRequest request, IncidentService service, CancellationToken cancellationToken) =>
            ExecuteAsync(async token =>
            {
                var incident = await service.CreateAsync(request, token);
                return Results.Created($"/api/incidents/{incident.Id}", incident);
            }, cancellationToken));

        app.MapGet("/api/incidents/{id:long:min(1)}", (long id, long? beforeEventSequence, IncidentService service, CancellationToken cancellationToken) =>
            ExecuteAsync(async token =>
            {
                var incident = await service.GetAsync(id, token, beforeEventSequence);
                return incident is null
                    ? Results.Problem(statusCode: 404, title: "Incident not found")
                    : Results.Ok(incident);
            }, cancellationToken));

        app.MapPost("/api/incidents/{id:long:min(1)}/notes", (long id, AddIncidentNoteRequest request, IncidentService service, CancellationToken cancellationToken) =>
            ExecuteAsync(token => CommandResultAsync(service, id, IncidentWorkflow.Note(request), token), cancellationToken));
        app.MapPost("/api/incidents/{id:long:min(1)}/transitions", (long id, TransitionIncidentRequest request, IncidentService service, CancellationToken cancellationToken) =>
            ExecuteAsync(token => CommandResultAsync(service, id, IncidentWorkflow.Transition(request), token), cancellationToken));
        app.MapPut("/api/incidents/{id:long:min(1)}/responder", (long id, ChangeIncidentResponderRequest request, IncidentService service, CancellationToken cancellationToken) =>
            ExecuteAsync(token => CommandResultAsync(service, id, IncidentWorkflow.Responder(request), token), cancellationToken));
    }

    private static async Task<IResult> CommandResultAsync(IncidentService service, long id, IncidentCommand command, CancellationToken cancellationToken)
    {
        var receipt = await service.ExecuteCommandAsync(id, command, cancellationToken);
        return receipt is null ? Results.Problem(statusCode: 404, title: "Incident not found") : Results.Ok(receipt);
    }

    public static IResult Conflict(IncidentWorkflowConflictException exception) => Results.Problem(
        statusCode: 409, title: "Incident workflow conflict", detail: exception.Message,
        extensions: new Dictionary<string, object?>
        {
            ["code"] = exception.Code, ["currentVersion"] = exception.CurrentVersion, ["currentStatus"] = exception.CurrentStatus
        });

    public static IResult CreationConflict(IncidentCreationConflictException exception) => Results.Problem(
        statusCode: 409, title: "Incident creation conflict", detail: exception.Message,
        extensions: new Dictionary<string, object?> { ["code"] = "creation_command_conflict" });

    public static IResult ConditionConflict(IncidentConditionChangedException exception) => Results.Problem(
        statusCode: 409, title: "Monitoring condition changed", detail: exception.Message,
        extensions: new Dictionary<string, object?> { ["code"] = "condition_changed" });

    private static bool IsWrappedIncidentStorageFailure(Exception exception)
    {
        // EF's execution strategy can wrap a provider failure in InvalidOperationException.
        // The wrapper alone is not evidence of unavailable storage. In particular,
        // transient transaction conflicts are not connection failures.
        var providerConnectionFailure = false;
        for (var inner = exception.InnerException; inner is not null; inner = inner.InnerException)
        {
            if (inner is PostgresException postgres)
                return postgres.SqlState.StartsWith("08", StringComparison.Ordinal) // connection exception
                    || postgres.SqlState.StartsWith("28", StringComparison.Ordinal) // connection authorization
                    || postgres.SqlState is PostgresErrorCodes.AdminShutdown
                        or PostgresErrorCodes.CrashShutdown or PostgresErrorCodes.CannotConnectNow;
            // An inner PostgreSQL error takes precedence over its provider wrapper's
            // IsTransient flag, which can also describe transaction conflicts.
            if (inner is NpgsqlException { IsTransient: true }) providerConnectionFailure = true;
        }
        return providerConnectionFailure;
    }

    private static async Task<IResult> ExecuteAsync(Func<CancellationToken, Task<IResult>> action, CancellationToken requestCancellation)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(requestCancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        try { return await action(timeout.Token); }
        catch (IncidentWorkflowConflictException exception) { return Conflict(exception); }
        catch (IncidentCreationConflictException exception) { return CreationConflict(exception); }
        catch (IncidentValidationException exception) { return Results.Problem(statusCode: 400, title: "Invalid incident request", detail: exception.Message); }
        catch (IncidentConditionChangedException exception) { return ConditionConflict(exception); }
        catch (Exception exception) when (exception is PrometheusQueryException or HttpRequestException)
        { return Results.Problem(statusCode: 503, title: "Prometheus telemetry is unavailable"); }
        catch (Exception exception) when (exception is IncidentStorageUnavailableException or System.Data.Common.DbException or DbUpdateException
            || IsWrappedIncidentStorageFailure(exception))
        { return Results.Problem(statusCode: 503, title: "Incident storage is unavailable"); }
        catch (OperationCanceledException) when (!requestCancellation.IsCancellationRequested)
        { return Results.Problem(statusCode: 503, title: "Incident dependency request timed out"); }
    }
}
