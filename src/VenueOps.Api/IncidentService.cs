using Microsoft.EntityFrameworkCore;

namespace VenueOps.Api;

public sealed class IncidentService(IncidentDbContext database, PrometheusClient prometheus, TimeProvider timeProvider)
{
    public async Task<IncidentResponse> CreateAsync(CreateIncidentRequest request, CancellationToken cancellationToken)
    {
        request.Validate();
        await IncidentPersistenceHealthCheck.EnsureReadyAsync(database, cancellationToken);
        var capture = await prometheus.GetIncidentMonitoringCaptureAsync(cancellationToken);
        var incident = Incident.Create(request, capture, timeProvider.GetUtcNow());
        database.Incidents.Add(incident);
        // EF commits this complete graph in one transaction; monitoring I/O precedes it.
        await database.SaveChangesAsync(cancellationToken);
        return incident.ToResponse();
    }

    public async Task<IncidentResponse?> GetAsync(long id, CancellationToken cancellationToken)
    {
        var incident = await database.Incidents.AsNoTracking()
            .Include(item => item.AccessPoints).Include(item => item.Events).AsSingleQuery()
            .SingleOrDefaultAsync(item => item.Id == id, cancellationToken);
        return incident?.ToResponse();
    }
}
