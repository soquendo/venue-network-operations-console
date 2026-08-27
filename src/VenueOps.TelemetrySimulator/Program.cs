using Prometheus;
using VenueOps.TelemetrySimulator;

Metrics.SuppressDefaultMetrics();

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHealthChecks();
builder.Services.AddSingleton<AccessPointStateStore>();
builder.Services.AddSingleton<AccessPointMetricsPublisher>();

var app = builder.Build();

var store = app.Services.GetRequiredService<AccessPointStateStore>();
var metrics = app.Services.GetRequiredService<AccessPointMetricsPublisher>();
metrics.Publish(store.GetAll());

app.UseHttpMetrics();

app.MapHealthChecks("/health/live");
app.MapMetrics();

app.MapPut("/simulation/access-points/{apId}", (
    string apId,
    ScenarioRequest request,
    AccessPointStateStore accessPoints,
    AccessPointMetricsPublisher publisher) =>
{
    if (!AccessPointScenario.TryParse(request.Scenario, out var scenario))
    {
        return Results.BadRequest(new
        {
            error = "Unsupported scenario. Allowed values are 'healthy' and 'offline'."
        });
    }

    if (!accessPoints.TrySetScenario(apId, scenario, out var updated))
    {
        return Results.NotFound(new { error = $"Access point '{apId}' was not found." });
    }

    publisher.Publish(updated);
    return Results.Ok(new ScenarioResponse(updated.ApId, updated.Zone, updated.Scenario));
});

app.Run();

public sealed record ScenarioRequest(string? Scenario);
public sealed record ScenarioResponse(string ApId, string Zone, string Scenario);
