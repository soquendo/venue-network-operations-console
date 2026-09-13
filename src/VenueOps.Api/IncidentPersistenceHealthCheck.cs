using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace VenueOps.Api;

public sealed class IncidentPersistenceHealthCheck(IServiceScopeFactory scopes) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        using var scope = scopes.CreateScope();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            await EnsureReadyAsync(scope.ServiceProvider.GetRequiredService<IncidentDbContext>(), timeout.Token);
            return HealthCheckResult.Healthy();
        }
        catch (Exception exception) when (exception is IncidentStorageUnavailableException
            or System.Data.Common.DbException or OperationCanceledException)
        {
            return HealthCheckResult.Unhealthy("Incident storage or its expected schema is unavailable.");
        }
    }

    public static async Task EnsureReadyAsync(IncidentDbContext database, CancellationToken cancellationToken)
    {
        if (!await database.Database.CanConnectAsync(cancellationToken)
            || (await database.Database.GetPendingMigrationsAsync(cancellationToken)).Any())
            throw new IncidentStorageUnavailableException();
        await database.Incidents.AsNoTracking().Include(item => item.AccessPoints)
            .Include(item => item.Events.OrderBy(entry => entry.Sequence).Take(1))
            .AsSingleQuery().Take(1).ToListAsync(cancellationToken);
    }
}

public sealed class IncidentStorageUnavailableException : Exception;
