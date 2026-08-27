using System.Net;
using System.Text;
using VenueOps.Api;
using Xunit;

namespace VenueOps.Api.Tests;

public sealed class PrometheusClientTests
{
    [Fact]
    public async Task MapsFixedPrometheusQueriesIntoViabilityResponse()
    {
        var handler = new StubPrometheusHandler(expression => expression switch
        {
            "venue_ap_operational{ap_id=\"ap-001\"}" => Vector("1", ("ap_id", "ap-001"), ("zone", "zone-a")),
            "zone:venue_ap_operational:avg{zone=\"zone-a\"}" => Vector("1", ("zone", "zone-a")),
            "up{job=\"venue-ap-simulator\"}" => Vector("1", ("job", "venue-ap-simulator")),
            "probe_success{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}" => Vector("1"),
            "probe_duration_seconds{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}" => Vector("0.012"),
            "probe_http_status_code{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}" => Vector("200"),
            "ALERTS{alertname=\"VenueApDown\",ap_id=\"ap-001\"}" => EmptyVector(),
            _ => throw new InvalidOperationException($"Unexpected query: {expression}")
        });
        var httpClient = new HttpClient(handler) { BaseAddress = new Uri("http://prometheus:9090") };
        var client = new PrometheusClient(httpClient);

        var result = await client.GetViabilityAsync(CancellationToken.None);

        Assert.True(result.Ap.Operational);
        Assert.Equal("simulated", result.Ap.Source);
        Assert.Equal(1, result.Zone.OperationalRatio);
        Assert.True(result.Probe.Success);
        Assert.Equal(200, result.Probe.HttpStatusCode);
        Assert.True(result.SimulatorScrape.Up);
        Assert.Equal("inactive", result.Alert.State);
    }

    [Fact]
    public async Task MissingRequiredSeriesFailsInsteadOfCreatingAHealthyDefault()
    {
        var handler = new StubPrometheusHandler(_ => EmptyVector());
        var httpClient = new HttpClient(handler) { BaseAddress = new Uri("http://prometheus:9090") };
        var client = new PrometheusClient(httpClient);

        var exception = await Assert.ThrowsAsync<PrometheusQueryException>(
            () => client.GetViabilityAsync(CancellationToken.None));

        Assert.Contains("Expected exactly one series", exception.Message);
    }

    [Fact]
    public async Task MalformedPrometheusJsonFailsExplicitly()
    {
        var handler = new StubPrometheusHandler(_ => "not-json");
        var httpClient = new HttpClient(handler) { BaseAddress = new Uri("http://prometheus:9090") };
        var client = new PrometheusClient(httpClient);

        var exception = await Assert.ThrowsAsync<PrometheusQueryException>(
            () => client.GetViabilityAsync(CancellationToken.None));

        Assert.Contains("invalid JSON", exception.Message);
    }

    private static string Vector(string value, params (string Key, string Value)[] labels)
    {
        var metric = string.Join(",", labels.Select(label => $"\"{label.Key}\":\"{label.Value}\""));
        return "{\"status\":\"success\",\"data\":{\"resultType\":\"vector\",\"result\":[{\"metric\":{" +
            metric +
            "},\"value\":[1787750400.0,\"" +
            value +
            "\"]}]}}";
    }

    private static string EmptyVector() =>
        """
        {"status":"success","data":{"resultType":"vector","result":[]}}
        """;

    private sealed class StubPrometheusHandler(Func<string, string> responseFactory) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var query = request.RequestUri?.Query ?? throw new InvalidOperationException("Query was missing.");
            var encodedExpression = query.Split("query=", 2, StringSplitOptions.None)[1];
            var expression = Uri.UnescapeDataString(encodedExpression.Replace('+', ' '));
            var json = responseFactory(expression);

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            });
        }
    }
}
