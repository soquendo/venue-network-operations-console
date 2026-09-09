using System.Net;
using System.Text;
using VenueOps.Api;
using Xunit;

namespace VenueOps.Api.Tests;

public sealed class PrometheusClientTests
{
    [Fact]
    public async Task MapsAllAccessPointAndZoneSeriesIntoOperationsOverview()
    {
        var handler = new StubPrometheusHandler(expression => expression switch
        {
            "venue_ap_operational" => ApVector("1", "1", "1", "1"),
            "venue_ap_clients" => ApVector("42", "35", "28", "31"),
            "venue_ap_channel_utilization_ratio" => ApVector("0.55", "0.48", "0.41", "0.46"),
            "venue_ap_management_latency_seconds" => ApVector("0.018", "0.016", "0.015", "0.017"),
            "venue_ap_management_packet_loss_ratio" => ApVector("0.002", "0.001", "0.001", "0.002"),
            "zone:venue_ap_operational:avg" => VectorOf(
                Sample("1", ("zone", "zone-a")),
                Sample("1", ("zone", "zone-b"))),
            "zone:venue_ap_clients:sum" => VectorOf(
                Sample("77", ("zone", "zone-a")),
                Sample("59", ("zone", "zone-b"))),
            "up{job=\"venue-ap-simulator\"}" => Vector("1", ("job", "venue-ap-simulator")),
            "probe_success{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}" => Vector("1"),
            "probe_duration_seconds{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}" => Vector("0.012"),
            "probe_http_status_code{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}" => Vector("200"),
            "ALERTS{alertname=\"VenueApDown\"}" => EmptyVector(),
            _ => throw new InvalidOperationException($"Unexpected query: {expression}")
        });
        var httpClient = new HttpClient(handler) { BaseAddress = new Uri("http://prometheus:9090") };
        var client = new PrometheusClient(httpClient);

        var result = await client.GetOperationsOverviewAsync(CancellationToken.None);

        Assert.Equal(4, result.AccessPoints.Count);
        var ap001 = Assert.Single(result.AccessPoints, accessPoint => accessPoint.ApId == "ap-001");
        Assert.True(ap001.Operational);
        Assert.Equal(42, ap001.Clients);
        Assert.Equal(0.55, ap001.ChannelUtilizationRatio);
        Assert.Equal("inactive", ap001.AlertState);
        Assert.Equal("simulated", ap001.Source);

        Assert.Equal(2, result.Zones.Count);
        var zoneA = Assert.Single(result.Zones, zone => zone.Zone == "zone-a");
        Assert.Equal(1, zoneA.OperationalRatio);
        Assert.Equal(77, zoneA.Clients);
        Assert.Equal("derived", zoneA.Source);
        Assert.True(result.Probe.Success);
        Assert.True(result.SimulatorScrape.Up);
    }

    [Fact]
    public async Task OfflineAccessPointKeepsIdentityAndUsesNullForUnavailableObservations()
    {
        var handler = new StubPrometheusHandler(expression => expression switch
        {
            "venue_ap_operational" => ApVector("0", "1", "1", "1"),
            "venue_ap_clients" => ApVector("0", "35", "28", "31"),
            "venue_ap_channel_utilization_ratio" => ApVectorFromAp002("0.48", "0.41", "0.46"),
            "venue_ap_management_latency_seconds" => ApVectorFromAp002("0.016", "0.015", "0.017"),
            "venue_ap_management_packet_loss_ratio" => ApVectorFromAp002("0.001", "0.001", "0.002"),
            "zone:venue_ap_operational:avg" => VectorOf(
                Sample("0.5", ("zone", "zone-a")),
                Sample("1", ("zone", "zone-b"))),
            "zone:venue_ap_clients:sum" => VectorOf(
                Sample("35", ("zone", "zone-a")),
                Sample("59", ("zone", "zone-b"))),
            "up{job=\"venue-ap-simulator\"}" => Vector("1"),
            "probe_success{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}" => Vector("1"),
            "probe_duration_seconds{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}" => Vector("0.012"),
            "probe_http_status_code{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}" => Vector("200"),
            "ALERTS{alertname=\"VenueApDown\"}" => Vector(
                "1",
                ("alertname", "VenueApDown"),
                ("alertstate", "firing"),
                ("ap_id", "ap-001"),
                ("zone", "zone-a")),
            _ => throw new InvalidOperationException($"Unexpected query: {expression}")
        });
        var httpClient = new HttpClient(handler) { BaseAddress = new Uri("http://prometheus:9090") };
        var client = new PrometheusClient(httpClient);

        var result = await client.GetOperationsOverviewAsync(CancellationToken.None);

        var ap001 = Assert.Single(result.AccessPoints, accessPoint => accessPoint.ApId == "ap-001");
        Assert.False(ap001.Operational);
        Assert.Equal(0, ap001.Clients);
        Assert.Null(ap001.ChannelUtilizationRatio);
        Assert.Null(ap001.ManagementLatencySeconds);
        Assert.Null(ap001.ManagementPacketLossRatio);
        Assert.Equal("firing", ap001.AlertState);
    }

    [Fact]
    public async Task MissingRequiredOverviewSeriesFailsInsteadOfReturningPartialData()
    {
        var handler = new StubPrometheusHandler(expression => expression switch
        {
            "venue_ap_operational" => ApVector("1", "1", "1", "1"),
            "venue_ap_clients" => EmptyVector(),
            "venue_ap_channel_utilization_ratio" => ApVector("0.55", "0.48", "0.41", "0.46"),
            "venue_ap_management_latency_seconds" => ApVector("0.018", "0.016", "0.015", "0.017"),
            "venue_ap_management_packet_loss_ratio" => ApVector("0.002", "0.001", "0.001", "0.002"),
            "zone:venue_ap_operational:avg" => VectorOf(
                Sample("1", ("zone", "zone-a")),
                Sample("1", ("zone", "zone-b"))),
            "zone:venue_ap_clients:sum" => VectorOf(
                Sample("77", ("zone", "zone-a")),
                Sample("59", ("zone", "zone-b"))),
            "up{job=\"venue-ap-simulator\"}" => Vector("1"),
            "probe_success{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}" => Vector("1"),
            "probe_duration_seconds{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}" => Vector("0.012"),
            "probe_http_status_code{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}" => Vector("200"),
            "ALERTS{alertname=\"VenueApDown\"}" => EmptyVector(),
            _ => EmptyVector()
        });
        var httpClient = new HttpClient(handler) { BaseAddress = new Uri("http://prometheus:9090") };
        var client = new PrometheusClient(httpClient);

        var exception = await Assert.ThrowsAsync<PrometheusQueryException>(
            () => client.GetOperationsOverviewAsync(CancellationToken.None));

        Assert.Contains("venue_ap_clients", exception.Message);
    }

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

    [Theory]
    [Trait("Category", "PrometheusValidation")]
    [InlineData("\"1787750400\"")]
    [InlineData("null")]
    [InlineData("true")]
    [InlineData("false")]
    [InlineData("[]")]
    [InlineData("{}")]
    public async Task RejectsNonNumericVectorTimestamps(string timestampJson)
    {
        var client = CreateViabilityClient(OperationalVectorWithTimestamp(timestampJson));

        await Assert.ThrowsAsync<PrometheusQueryException>(
            () => client.GetViabilityAsync(CancellationToken.None));
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
    public async Task RejectsUnrepresentableVectorTimestamps(string timestampJson)
    {
        var client = CreateViabilityClient(OperationalVectorWithTimestamp(timestampJson));

        await Assert.ThrowsAsync<PrometheusQueryException>(
            () => client.GetViabilityAsync(CancellationToken.None));
    }

    [Theory]
    [Trait("Category", "PrometheusValidation")]
    [InlineData("null")]
    [InlineData("""null,{"metric":{"ap_id":"ap-001","zone":"zone-a"},"value":[1787750400,"1"]}""")]
    [InlineData("""{"metric":{"ap_id":"ap-001","zone":"zone-a"},"value":[1787750400,"1"]},null""")]
    public async Task RejectsNullVectorResultEntries(string resultsJson)
    {
        var client = CreateViabilityClient(
            $$$"""
            {"status":"success","data":{"resultType":"vector","result":[{{{resultsJson}}}]}}
            """);

        await Assert.ThrowsAsync<PrometheusQueryException>(
            () => client.GetViabilityAsync(CancellationToken.None));
    }

    [Fact]
    [Trait("Category", "PrometheusValidation")]
    public async Task RejectsUnexpectedVectorResultType()
    {
        var client = CreateViabilityClient(
            """
            {"status":"success","data":{"resultType":"matrix","result":[
              {"metric":{"ap_id":"ap-001","zone":"zone-a"},"values":[[1787750400,"1"]]}
            ]}}
            """);

        var exception = await Assert.ThrowsAsync<PrometheusQueryException>(
            () => client.GetViabilityAsync(CancellationToken.None));

        Assert.Contains("Expected a Prometheus vector result", exception.Message);
    }

    [Theory]
    [Trait("Category", "PrometheusValidation")]
    [InlineData("1787750400.125", 1787750400125L)]
    [InlineData("1787750400.1234", 1787750400123L)]
    [InlineData("1787750400.1236", 1787750400124L)]
    [InlineData("0.0005", 0L)]
    [InlineData("0.0015", 2L)]
    [InlineData("-0.0005", 0L)]
    [InlineData("-0.0015", -2L)]
    [InlineData("-62135596800", -62135596800000L)]
    [InlineData("253402300799.999", 253402300799999L)]
    [InlineData("-62135596800.0004", -62135596800000L)]
    [InlineData("253402300799.9994", 253402300799999L)]
    public async Task PreservesVectorTimestampMillisecondConversion(
        string timestampJson,
        long expectedMilliseconds)
    {
        var client = CreateViabilityClient(OperationalVectorWithTimestamp(timestampJson));

        var result = await client.GetViabilityAsync(CancellationToken.None);

        Assert.Equal(
            DateTimeOffset.FromUnixTimeMilliseconds(expectedMilliseconds),
            result.Ap.ObservedAtUtc);
        Assert.True(result.Ap.Operational);
        Assert.Equal(1, result.Ap.Value);
    }

    private static PrometheusClient CreateViabilityClient(string operationalResponse)
    {
        var handler = new StubPrometheusHandler(expression => expression switch
        {
            "venue_ap_operational{ap_id=\"ap-001\"}" => operationalResponse,
            "zone:venue_ap_operational:avg{zone=\"zone-a\"}" => Vector("1", ("zone", "zone-a")),
            "up{job=\"venue-ap-simulator\"}" => Vector("1"),
            "probe_success{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}" => Vector("1"),
            "probe_duration_seconds{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}" => Vector("0.012"),
            "probe_http_status_code{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}" => Vector("200"),
            "ALERTS{alertname=\"VenueApDown\",ap_id=\"ap-001\"}" => EmptyVector(),
            _ => throw new InvalidOperationException($"Unexpected query: {expression}")
        });
        return new PrometheusClient(
            new HttpClient(handler) { BaseAddress = new Uri("http://prometheus:9090") });
    }

    private static string OperationalVectorWithTimestamp(string timestampJson) =>
        $$$"""
        {"status":"success","data":{"resultType":"vector","result":[
          {"metric":{"ap_id":"ap-001","zone":"zone-a"},"value":[{{{timestampJson}}},"1"]}
        ]}}
        """;

    private static string Vector(string value, params (string Key, string Value)[] labels)
    {
        var metric = string.Join(",", labels.Select(label => $"\"{label.Key}\":\"{label.Value}\""));
        return "{\"status\":\"success\",\"data\":{\"resultType\":\"vector\",\"result\":[{\"metric\":{" +
            metric +
            "},\"value\":[1787750400.0,\"" +
            value +
            "\"]}]}}";
    }

    private static string VectorOf(params StubSample[] samples)
    {
        var results = string.Join(",", samples.Select(sample =>
        {
            var metric = string.Join(",", sample.Labels.Select(label =>
                $"\"{label.Key}\":\"{label.Value}\""));
            return "{\"metric\":{" + metric + "},\"value\":[1787750400.0,\"" + sample.Value + "\"]}";
        }));

        return "{\"status\":\"success\",\"data\":{\"resultType\":\"vector\",\"result\":[" + results + "]}}";
    }

    private static StubSample Sample(string value, params (string Key, string Value)[] labels) =>
        new(value, labels);

    private static string ApVector(string ap001, string ap002, string ap003, string ap004) =>
        VectorOf(
            Sample(ap001, ("ap_id", "ap-001"), ("zone", "zone-a")),
            Sample(ap002, ("ap_id", "ap-002"), ("zone", "zone-a")),
            Sample(ap003, ("ap_id", "ap-003"), ("zone", "zone-b")),
            Sample(ap004, ("ap_id", "ap-004"), ("zone", "zone-b")));

    private static string ApVectorFromAp002(string ap002, string ap003, string ap004) =>
        VectorOf(
            Sample(ap002, ("ap_id", "ap-002"), ("zone", "zone-a")),
            Sample(ap003, ("ap_id", "ap-003"), ("zone", "zone-b")),
            Sample(ap004, ("ap_id", "ap-004"), ("zone", "zone-b")));

    private static string EmptyVector() =>
        """
        {"status":"success","data":{"resultType":"vector","result":[]}}
        """;

    private sealed record StubSample(
        string Value,
        IReadOnlyList<(string Key, string Value)> Labels);

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
