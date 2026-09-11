using Prometheus;
using System.Text.Json.Serialization;
using VenueOps.TelemetrySimulator;

Metrics.SuppressDefaultMetrics();

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHealthChecks();
builder.Services.AddSingleton<AccessPointStateStore>();
builder.Services.AddSingleton(Metrics.DefaultRegistry);
builder.Services.AddSingleton<AccessPointMetricsPublisher>();

var app = builder.Build();

var store = app.Services.GetRequiredService<AccessPointStateStore>();
var metrics = app.Services.GetRequiredService<AccessPointMetricsPublisher>();
app.UseHttpMetrics();
app.Use(async (context, next) =>
{
    if (string.Equals(context.Request.Path.Value?.TrimEnd('/'), "/metrics", StringComparison.OrdinalIgnoreCase))
    {
        await metrics.ExportAsync(store.GetAll, () => next(context), context.RequestAborted);
        return;
    }
    await next(context);
});

app.MapHealthChecks("/health/live");
app.MapMetrics();

app.MapPut("/simulation/access-points/{apId}", (
    string apId,
    ScenarioRequest request,
    AccessPointStateStore accessPoints) =>
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

    return Results.Ok(new ScenarioResponse(updated.ApId, updated.Zone, updated.Scenario));
});

app.MapGet("/simulation/event-day", (AccessPointStateStore accessPoints) => accessPoints.GetEventDay());
app.MapPut("/simulation/event-day/position", (EventPositionRequest request, AccessPointStateStore accessPoints) =>
{
    if (request.ElapsedMinutes is not int minute || minute is < 0 or > 660)
    {
        return Results.BadRequest(new { error = "Use an integer virtual minute from 0 through 660." });
    }
    return Results.Ok(accessPoints.SetEventPosition(minute));
});
app.MapPost("/simulation/event-day/reset", (AccessPointStateStore accessPoints) => accessPoints.ResetEventDay());

app.Run();

public sealed record ScenarioRequest(string? Scenario);
public sealed record ScenarioResponse(string ApId, string Zone, string Scenario);
public sealed record EventPositionRequest([property: JsonNumberHandling(JsonNumberHandling.Strict)] int? ElapsedMinutes);
