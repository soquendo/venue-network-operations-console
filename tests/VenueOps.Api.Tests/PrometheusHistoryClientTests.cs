using System.Net;
using System.Text;
using VenueOps.Api;
using Xunit;

namespace VenueOps.Api.Tests;

public sealed class PrometheusHistoryClientTests
{
    [Fact]
    public async Task DerivesQualityFromCollectedPeakAndRecoveryWithoutAddingSamples()
    {
        var values = new Dictionary<string, string[]>
        {
            ["venue_ap_operational"] = ["1", "1", "1"],
            ["venue_ap_clients"] = ["42", "84", "63"],
            ["venue_ap_channel_utilization_ratio"] = ["0.55", "0.95", "0.75"],
            ["venue_ap_management_latency_seconds"] = ["0.018", "0.078", "0.038"],
            ["venue_ap_management_packet_loss_ratio"] = ["0.002", "0.017", "0.002"]
        };
        var client = CreateHistoryClient((metric, _) => Matrix(
            [("ap_id", "ap-001"), ("zone", "zone-a")],
            [(FirstTimestamp, values[metric][0]), (SecondTimestamp, values[metric][1]), (ThirdTimestamp + 10, values[metric][2])]));
        var history = await client.GetAccessPointHistoryAsync("ap-001", "15m", CancellationToken.None);
        Assert.Equal(3, history.Samples.Count);
        Assert.Equal(new[] { FirstTimestamp, SecondTimestamp, ThirdTimestamp + 10 }, history.Samples.Select(sample => sample.ObservedAtUtc.ToUnixTimeSeconds()));
        Assert.All(history.Samples, sample => Assert.True(sample.Operational));
        var json = System.Text.Json.JsonSerializer.SerializeToElement(history, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
        Assert.Equal(new[] { false, true, false }, json.GetProperty("samples").EnumerateArray().Select(sample => sample.GetProperty("degraded").GetBoolean()));
    }

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

    [Theory]
    [Trait("Category", "PrometheusValidation")]
    [InlineData("\"1787840000\"")]
    [InlineData("null")]
    [InlineData("true")]
    [InlineData("false")]
    [InlineData("[]")]
    [InlineData("{}")]
    public async Task RejectsNonNumericHistoryTimestamps(string timestampJson)
    {
        var client = CreateClientWithRangeResponse(
            "venue_ap_operational",
            MatrixWithTimestamp(timestampJson, "1"));

        await Assert.ThrowsAsync<PrometheusQueryException>(
            () => client.GetAccessPointHistoryAsync("ap-001", "15m", CancellationToken.None));
    }

    [Theory]
    [Trait("Category", "PrometheusValidation")]
    [InlineData("253402300800")]
    [InlineData("-62135596801")]
    [InlineData("253402300799.9995")]
    [InlineData("-62135596800.0006")]
    [InlineData("1e20")]
    [InlineData("-1e20")]
    [InlineData("1e308")]
    [InlineData("-1e308")]
    [InlineData("1e400")]
    [InlineData("-1e400")]
    public async Task RejectsUnrepresentableHistoryTimestamps(string timestampJson)
    {
        var client = CreateClientWithRangeResponse(
            "venue_ap_operational",
            MatrixWithTimestamp(timestampJson, "1"));

        await Assert.ThrowsAsync<PrometheusQueryException>(
            () => client.GetAccessPointHistoryAsync("ap-001", "15m", CancellationToken.None));
    }

    [Theory]
    [Trait("Category", "PrometheusValidation")]
    [InlineData("null")]
    [InlineData("""null,{"metric":{"ap_id":"ap-001","zone":"zone-a"},"values":[[1787840000,"1"]]}""")]
    [InlineData("""{"metric":{"ap_id":"ap-001","zone":"zone-a"},"values":[[1787840000,"1"]]},null""")]
    public async Task RejectsNullMatrixResultEntries(string resultsJson)
    {
        var client = CreateClientWithRangeResponse(
            "venue_ap_operational",
            $$$"""
            {"status":"success","data":{"resultType":"matrix","result":[{{{resultsJson}}}]}}
            """);

        await Assert.ThrowsAsync<PrometheusQueryException>(
            () => client.GetAccessPointHistoryAsync("ap-001", "15m", CancellationToken.None));
    }

    [Fact]
    [Trait("Category", "PrometheusValidation")]
    public async Task RejectsUnexpectedHistoryResultType()
    {
        var client = CreateClientWithRangeResponse(
            "venue_ap_operational",
            Vector("1", ("ap_id", "ap-001"), ("zone", "zone-a")));

        var exception = await Assert.ThrowsAsync<PrometheusQueryException>(
            () => client.GetAccessPointHistoryAsync("ap-001", "15m", CancellationToken.None));

        Assert.Contains("Expected a Prometheus matrix result", exception.Message);
    }

    [Theory]
    [Trait("Category", "PrometheusValidation")]
    [InlineData("venue_ap_operational", "ap-002", "zone-a")]
    [InlineData("venue_ap_clients", "ap-001", "zone-b")]
    [InlineData("venue_ap_channel_utilization_ratio", "ap-002", "zone-a")]
    [InlineData("venue_ap_management_latency_seconds", "ap-001", "zone-b")]
    [InlineData("venue_ap_management_packet_loss_ratio", "ap-002", "zone-a")]
    public async Task RejectsUnexpectedHistoryIdentities(string metric, string apId, string zone)
    {
        var client = CreateClientWithRangeResponse(
            metric,
            Matrix([("ap_id", apId), ("zone", zone)], [(FirstTimestamp, "1")]));

        var exception = await Assert.ThrowsAsync<PrometheusQueryException>(
            () => client.GetAccessPointHistoryAsync("ap-001", "15m", CancellationToken.None));

        Assert.Contains(metric, exception.Message);
        Assert.Contains("unexpected access point or zone", exception.Message);
    }

    [Theory]
    [Trait("Category", "PrometheusValidation")]
    [InlineData("venue_ap_operational")]
    [InlineData("venue_ap_clients")]
    [InlineData("venue_ap_channel_utilization_ratio")]
    [InlineData("venue_ap_management_latency_seconds")]
    [InlineData("venue_ap_management_packet_loss_ratio")]
    public async Task RejectsDuplicateHistoryTimestamps(string metric)
    {
        var client = CreateClientWithRangeResponse(
            metric,
            Matrix(
                [("ap_id", "ap-001"), ("zone", "zone-a")],
                [(FirstTimestamp, "1"), (FirstTimestamp, "1")]));

        var exception = await Assert.ThrowsAsync<PrometheusQueryException>(
            () => client.GetAccessPointHistoryAsync("ap-001", "15m", CancellationToken.None));

        Assert.Contains(metric, exception.Message);
        Assert.Contains("duplicate timestamp", exception.Message);
    }

    [Fact]
    [Trait("Category", "PrometheusValidation")]
    public async Task RejectsOperationalHistoryTimestampsThatRoundToSameMillisecond()
    {
        var client = CreateClientWithRangeResponse(
            "venue_ap_operational",
            """
            {"status":"success","data":{"resultType":"matrix","result":[
              {"metric":{"ap_id":"ap-001","zone":"zone-a"},
               "values":[[1787840000.0001,"1"],[1787840000.0004,"1"]]}
            ]}}
            """);

        var exception = await Assert.ThrowsAsync<PrometheusQueryException>(
            () => client.GetAccessPointHistoryAsync("ap-001", "15m", CancellationToken.None));

        Assert.Contains("venue_ap_operational", exception.Message);
        Assert.Contains("duplicate timestamp", exception.Message);
    }

    [Theory]
    [Trait("Category", "PrometheusValidation")]
    [InlineData("1787840000.125", 1787840000125L)]
    [InlineData("1787840000.1234", 1787840000123L)]
    [InlineData("1787840000.1236", 1787840000124L)]
    [InlineData("0.0005", 0L)]
    [InlineData("0.0015", 2L)]
    [InlineData("-0.0005", 0L)]
    [InlineData("-0.0015", -2L)]
    [InlineData("-62135596800", -62135596800000L)]
    [InlineData("253402300799.999", 253402300799999L)]
    [InlineData("-62135596800.0004", -62135596800000L)]
    [InlineData("253402300799.9994", 253402300799999L)]
    public async Task PreservesHistoryTimestampMillisecondConversion(
        string timestampJson,
        long expectedMilliseconds)
    {
        var client = CreateHistoryClient((_, value) => MatrixWithTimestamp(timestampJson, value));

        var result = await client.GetAccessPointHistoryAsync("ap-001", "15m", CancellationToken.None);

        var sample = Assert.Single(result.Samples);
        Assert.Equal(
            DateTimeOffset.FromUnixTimeMilliseconds(expectedMilliseconds),
            sample.ObservedAtUtc);
        Assert.True(sample.Operational);
        Assert.Equal(42, sample.Clients);
        Assert.Equal(0.55, sample.ChannelUtilizationRatio);
        Assert.Equal(0.018, sample.ManagementLatencySeconds);
        Assert.Equal(0.002, sample.ManagementPacketLossRatio);
    }

    [Fact]
    [Trait("Category", "PrometheusValidation")]
    public async Task PreservesSparseHistoryInTimestampOrder()
    {
        var client = CreateHistoryClient((metric, value) => Matrix(
            [("ap_id", "ap-001"), ("zone", "zone-a")],
            metric == "venue_ap_clients"
                ? [(FirstTimestamp, "10"), (ThirdTimestamp, "20")]
                : [(ThirdTimestamp, value), (FirstTimestamp, value)]));

        var result = await client.GetAccessPointHistoryAsync("ap-001", "15m", CancellationToken.None);

        Assert.Collection(
            result.Samples,
            first =>
            {
                Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(FirstTimestamp), first.ObservedAtUtc);
                Assert.Equal(10, first.Clients);
            },
            last =>
            {
                Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(ThirdTimestamp), last.ObservedAtUtc);
                Assert.Equal(20, last.Clients);
            });
    }

    [Fact]
    [Trait("Category", "PrometheusValidation")]
    public async Task PreservesNumericZeroForHealthyHistoryObservations()
    {
        var client = CreateHistoryClient((metric, _) => MatrixWithTimestamp(
            "1787840000",
            metric == "venue_ap_operational" ? "1" : "0"));

        var result = await client.GetAccessPointHistoryAsync("ap-001", "15m", CancellationToken.None);

        var sample = Assert.Single(result.Samples);
        Assert.True(sample.Operational);
        Assert.Equal(0, sample.Clients);
        Assert.Equal(0, sample.ChannelUtilizationRatio);
        Assert.Equal(0, sample.ManagementLatencySeconds);
        Assert.Equal(0, sample.ManagementPacketLossRatio);
    }

    [Fact]
    [Trait("Category", "PrometheusValidation")]
    public async Task OfflineHistoryAllowsMissingOptionalSeries()
    {
        var client = CreateHistoryClient((metric, _) =>
            metric is "venue_ap_operational" or "venue_ap_clients"
                ? MatrixWithTimestamp("1787840000", "0")
                : """{"status":"success","data":{"resultType":"matrix","result":[]}}""");

        var result = await client.GetAccessPointHistoryAsync("ap-001", "15m", CancellationToken.None);

        var sample = Assert.Single(result.Samples);
        Assert.False(sample.Operational);
        Assert.Equal(0, sample.Clients);
        Assert.Null(sample.ChannelUtilizationRatio);
        Assert.Null(sample.ManagementLatencySeconds);
        Assert.Null(sample.ManagementPacketLossRatio);
    }

    private static PrometheusClient CreateClientWithRangeResponse(string metric, string response) =>
        CreateHistoryClient((queriedMetric, value) => queriedMetric == metric
            ? response
            : MatrixWithTimestamp("1787840000", value));

    private static PrometheusClient CreateHistoryClient(Func<string, string, string> rangeResponseFactory)
    {
        var handler = new StubPrometheusHandler((path, expression) => (path, expression) switch
        {
            ("/api/v1/query", "venue_ap_operational{ap_id=\"ap-001\"}") =>
                Vector("1", ("ap_id", "ap-001"), ("zone", "zone-a")),
            ("/api/v1/query_range", "venue_ap_operational{ap_id=\"ap-001\",zone=\"zone-a\"}") =>
                rangeResponseFactory("venue_ap_operational", "1"),
            ("/api/v1/query_range", "venue_ap_clients{ap_id=\"ap-001\",zone=\"zone-a\"}") =>
                rangeResponseFactory("venue_ap_clients", "42"),
            ("/api/v1/query_range", "venue_ap_channel_utilization_ratio{ap_id=\"ap-001\",zone=\"zone-a\"}") =>
                rangeResponseFactory("venue_ap_channel_utilization_ratio", "0.55"),
            ("/api/v1/query_range", "venue_ap_management_latency_seconds{ap_id=\"ap-001\",zone=\"zone-a\"}") =>
                rangeResponseFactory("venue_ap_management_latency_seconds", "0.018"),
            ("/api/v1/query_range", "venue_ap_management_packet_loss_ratio{ap_id=\"ap-001\",zone=\"zone-a\"}") =>
                rangeResponseFactory("venue_ap_management_packet_loss_ratio", "0.002"),
            _ => throw new InvalidOperationException($"Unexpected request: {path} {expression}")
        });
        return CreateClient(handler);
    }

    private static string MatrixWithTimestamp(string timestampJson, string value) =>
        $$$"""
        {"status":"success","data":{"resultType":"matrix","result":[
          {"metric":{"ap_id":"ap-001","zone":"zone-a"},"values":[[{{{timestampJson}}},"{{{value}}}"]]}
        ]}}
        """;

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
