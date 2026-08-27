using System.Net;
using System.Text;
using VenueOps.Api;
using Xunit;

namespace VenueOps.Api.Tests;

public sealed class PrometheusHistoryClientTests
{
    private const long FirstTimestamp = 1_787_840_000;
    private const long SecondTimestamp = FirstTimestamp + 5;
    private const long ThirdTimestamp = FirstTimestamp + 10;

    [Fact]
    public async Task AlignsRangeSeriesAndUsesNullForUnavailableOfflineObservations()
    {
        var handler = new StubPrometheusHandler((path, expression) => (path, expression) switch
        {
            ("/api/v1/query", "venue_ap_operational{ap_id=\"ap-001\"}") =>
                Vector("1", ("ap_id", "ap-001"), ("zone", "zone-a")),
            ("/api/v1/query_range", "venue_ap_operational{ap_id=\"ap-001\",zone=\"zone-a\"}") =>
                Matrix(
                    [("ap_id", "ap-001"), ("zone", "zone-a")],
                    [(FirstTimestamp, "1"), (SecondTimestamp, "0"), (ThirdTimestamp, "1")]),
            ("/api/v1/query_range", "venue_ap_clients{ap_id=\"ap-001\",zone=\"zone-a\"}") =>
                Matrix(
                    [("ap_id", "ap-001"), ("zone", "zone-a")],
                    [(FirstTimestamp, "42"), (SecondTimestamp, "0"), (ThirdTimestamp, "42")]),
            ("/api/v1/query_range", "venue_ap_channel_utilization_ratio{ap_id=\"ap-001\",zone=\"zone-a\"}") =>
                Matrix(
                    [("ap_id", "ap-001"), ("zone", "zone-a")],
                    [(FirstTimestamp, "0.55"), (ThirdTimestamp, "0.55")]),
            ("/api/v1/query_range", "venue_ap_management_latency_seconds{ap_id=\"ap-001\",zone=\"zone-a\"}") =>
                Matrix(
                    [("ap_id", "ap-001"), ("zone", "zone-a")],
                    [(FirstTimestamp, "0.018"), (ThirdTimestamp, "0.018")]),
            ("/api/v1/query_range", "venue_ap_management_packet_loss_ratio{ap_id=\"ap-001\",zone=\"zone-a\"}") =>
                Matrix(
                    [("ap_id", "ap-001"), ("zone", "zone-a")],
                    [(FirstTimestamp, "0.002"), (ThirdTimestamp, "0.002")]),
            _ => throw new InvalidOperationException($"Unexpected request: {path} {expression}")
        });
        var client = CreateClient(handler);

        var result = await client.GetAccessPointHistoryAsync(
            "ap-001",
            "15m",
            CancellationToken.None);

        Assert.Equal("ap-001", result.ApId);
        Assert.Equal("zone-a", result.Zone);
        Assert.Equal("15m", result.Window);
        Assert.Equal(5, result.StepSeconds);
        Assert.Equal("simulated", result.Source);
        Assert.Equal(3, result.Samples.Count);

        var offline = result.Samples[1];
        Assert.False(offline.Operational);
        Assert.Equal(0, offline.Clients);
        Assert.Null(offline.ChannelUtilizationRatio);
        Assert.Null(offline.ManagementLatencySeconds);
        Assert.Null(offline.ManagementPacketLossRatio);

        var recovered = result.Samples[2];
        Assert.True(recovered.Operational);
        Assert.Equal(0.55, recovered.ChannelUtilizationRatio);
    }

    [Fact]
    public async Task RejectsUnsupportedWindowBeforeQueryingPrometheus()
    {
        var handler = new StubPrometheusHandler((_, _) =>
            throw new InvalidOperationException("Prometheus should not be queried."));
        var client = CreateClient(handler);

        var exception = await Assert.ThrowsAsync<UnsupportedHistoryWindowException>(
            () => client.GetAccessPointHistoryAsync(
                "ap-001",
                "7d",
                CancellationToken.None));

        Assert.Contains("15m, 1h, 6h, or 24h", exception.Message);
    }

    [Fact]
    public async Task UnknownAccessPointFailsExplicitly()
    {
        var handler = new StubPrometheusHandler((path, expression) => (path, expression) switch
        {
            ("/api/v1/query", "venue_ap_operational{ap_id=\"ap-999\"}") => EmptyVector(),
            _ => throw new InvalidOperationException($"Unexpected request: {path} {expression}")
        });
        var client = CreateClient(handler);

        await Assert.ThrowsAsync<AccessPointNotFoundException>(
            () => client.GetAccessPointHistoryAsync(
                "ap-999",
                "15m",
                CancellationToken.None));
    }

    [Fact]
    public async Task MissingRequiredClientPointFailsInsteadOfFabricatingHistory()
    {
        var handler = new StubPrometheusHandler((path, expression) => (path, expression) switch
        {
            ("/api/v1/query", "venue_ap_operational{ap_id=\"ap-001\"}") =>
                Vector("1", ("ap_id", "ap-001"), ("zone", "zone-a")),
            ("/api/v1/query_range", "venue_ap_operational{ap_id=\"ap-001\",zone=\"zone-a\"}") =>
                Matrix(
                    [("ap_id", "ap-001"), ("zone", "zone-a")],
                    [(FirstTimestamp, "1"), (SecondTimestamp, "1")]),
            ("/api/v1/query_range", "venue_ap_clients{ap_id=\"ap-001\",zone=\"zone-a\"}") =>
                Matrix(
                    [("ap_id", "ap-001"), ("zone", "zone-a")],
                    [(FirstTimestamp, "42")]),
            ("/api/v1/query_range", _) =>
                Matrix(
                    [("ap_id", "ap-001"), ("zone", "zone-a")],
                    [(FirstTimestamp, "0.1"), (SecondTimestamp, "0.1")]),
            _ => throw new InvalidOperationException($"Unexpected request: {path} {expression}")
        });
        var client = CreateClient(handler);

        var exception = await Assert.ThrowsAsync<PrometheusQueryException>(
            () => client.GetAccessPointHistoryAsync(
                "ap-001",
                "15m",
                CancellationToken.None));

        Assert.Contains("venue_ap_clients", exception.Message);
    }

    private static PrometheusClient CreateClient(HttpMessageHandler handler) =>
        new(new HttpClient(handler) { BaseAddress = new Uri("http://prometheus:9090") });

    private static string Vector(string value, params (string Key, string Value)[] labels)
    {
        var metric = string.Join(",", labels.Select(label =>
            $"\"{label.Key}\":\"{label.Value}\""));
        return "{\"status\":\"success\",\"data\":{\"resultType\":\"vector\",\"result\":[{" +
            "\"metric\":{" + metric + "},\"value\":[1787840000,\"" + value + "\"]}]}}";
    }

    private static string Matrix(
        IReadOnlyList<(string Key, string Value)> labels,
        IReadOnlyList<(long Timestamp, string Value)> values)
    {
        var metric = string.Join(",", labels.Select(label =>
            $"\"{label.Key}\":\"{label.Value}\""));
        var samples = string.Join(",", values.Select(sample =>
            $"[{sample.Timestamp},\"{sample.Value}\"]"));
        return "{\"status\":\"success\",\"data\":{\"resultType\":\"matrix\",\"result\":[{" +
            "\"metric\":{" + metric + "},\"values\":[" + samples + "]}]}}";
    }

    private static string EmptyVector() =>
        """
        {"status":"success","data":{"resultType":"vector","result":[]}}
        """;

    private sealed class StubPrometheusHandler(
        Func<string, string, string> responseFactory) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var uri = request.RequestUri ?? throw new InvalidOperationException("Request URI was missing.");
            var queryParameters = uri.Query
                .TrimStart('?')
                .Split('&', StringSplitOptions.RemoveEmptyEntries)
                .Select(parameter => parameter.Split('=', 2))
                .ToDictionary(
                    parts => Uri.UnescapeDataString(parts[0]),
                    parts => Uri.UnescapeDataString(parts[1].Replace('+', ' ')),
                    StringComparer.Ordinal);
            var expression = queryParameters["query"];
            var json = responseFactory(uri.AbsolutePath, expression);

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            });
        }
    }
}
