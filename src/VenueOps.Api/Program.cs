using Prometheus;
using VenueOps.Api;

Metrics.SuppressDefaultMetrics();

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHealthChecks();
builder.Services.AddProblemDetails();

var prometheusBaseUrl = builder.Configuration["Prometheus:BaseUrl"] ?? "http://localhost:9090";
builder.Services.AddHttpClient<PrometheusClient>(client =>
{
    client.BaseAddress = new Uri(prometheusBaseUrl);
    client.Timeout = TimeSpan.FromSeconds(3);
});

var app = builder.Build();

app.UseHttpMetrics();

app.MapHealthChecks("/health/live");
app.MapMetrics();

app.MapGet("/api/viability", async (PrometheusClient prometheus, CancellationToken cancellationToken) =>
{
    try
    {
        var response = await prometheus.GetViabilityAsync(cancellationToken);
        return Results.Ok(response);
    }
    catch (Exception exception) when (exception is PrometheusQueryException
        or HttpRequestException
        or TaskCanceledException)
    {
        return Results.Problem(
            statusCode: StatusCodes.Status503ServiceUnavailable,
            title: "Prometheus telemetry is unavailable",
            detail: exception.Message);
    }
});

app.MapGet(
    "/api/operations/overview",
    async (PrometheusClient prometheus, CancellationToken cancellationToken) =>
    {
        try
        {
            var response = await prometheus.GetOperationsOverviewAsync(cancellationToken);
            return Results.Ok(response);
        }
        catch (Exception exception) when (exception is PrometheusQueryException
            or HttpRequestException
            or TaskCanceledException)
        {
            return Results.Problem(
                statusCode: StatusCodes.Status503ServiceUnavailable,
                title: "Prometheus telemetry is unavailable",
                detail: exception.Message);
        }
    });

app.Run();
