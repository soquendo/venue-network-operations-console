using Microsoft.EntityFrameworkCore;

namespace VenueOps.Api;

public static class IncidentEndpoints
{
    public static void MapIncidentEndpoints(this WebApplication app)
    {
        app.MapPost("/api/incidents", (CreateIncidentRequest request, IncidentService service, CancellationToken cancellationToken) =>
            ExecuteAsync(async token =>
            {
                var incident = await service.CreateAsync(request, token);
                return Results.Created($"/api/incidents/{incident.Id}", incident);
            }, cancellationToken));

        app.MapGet("/api/incidents/{id:long:min(1)}", (long id, IncidentService service, CancellationToken cancellationToken) =>
            ExecuteAsync(async token =>
            {
                var incident = await service.GetAsync(id, token);
                return incident is null
                    ? Results.Problem(statusCode: 404, title: "Incident not found")
                    : Results.Ok(incident);
            }, cancellationToken));
    }

    private static async Task<IResult> ExecuteAsync(Func<CancellationToken, Task<IResult>> action, CancellationToken requestCancellation)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(requestCancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        try { return await action(timeout.Token); }
        catch (IncidentValidationException exception) { return Results.Problem(statusCode: 400, title: "Invalid incident request", detail: exception.Message); }
        catch (IncidentConditionChangedException exception) { return Results.Problem(statusCode: 409, title: "Monitoring condition changed", detail: exception.Message); }
        catch (Exception exception) when (exception is PrometheusQueryException or HttpRequestException)
        { return Results.Problem(statusCode: 503, title: "Prometheus telemetry is unavailable"); }
        catch (Exception exception) when (exception is IncidentStorageUnavailableException or System.Data.Common.DbException or DbUpdateException)
        { return Results.Problem(statusCode: 503, title: "Incident storage is unavailable"); }
        catch (OperationCanceledException) when (!requestCancellation.IsCancellationRequested)
        { return Results.Problem(statusCode: 503, title: "Incident dependency request timed out"); }
    }
}
