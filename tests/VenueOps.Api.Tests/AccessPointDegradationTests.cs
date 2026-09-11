using System.Net;
using System.Text;
using System.Text.Json;
using VenueOps.Api;
using Xunit;

namespace VenueOps.Api.Tests;

public sealed class AccessPointDegradationTests
{
    // These named vectors also appear in tests/milestone5/venue.rules.test.yml.
    [Theory]
    [InlineData("offline", false, "0.95", "0.078", "0.017", false)]
    [InlineData("below-utilization", true, "0.799", "0.060", "0.020", false)]
    [InlineData("at-utilization-only", true, "0.80", "0.049", "0.009", false)]
    [InlineData("at-latency", true, "0.80", "0.050", "0.009", true)]
    [InlineData("at-loss", true, "0.80", "0.049", "0.010", true)]
    [InlineData("above-latency", true, "0.81", "0.051", "0.001", true)]
    [InlineData("above-loss", true, "0.81", "0.010", "0.011", true)]
    [InlineData("high-utilization-only", true, "0.95", "0.049", "0.009", false)]
    [InlineData("peak-ap-001", true, "0.95", "0.078", "0.017", true)]
    [InlineData("peak-ap-002", true, "0.88", "0.062", "0.009", true)]
    [InlineData("peak-ap-003", true, "0.61", "0.015", "0.001", false)]
    [InlineData("peak-ap-004", true, "0.66", "0.019", "0.002", false)]
    [InlineData("recovery-ap-001", true, "0.75", "0.038", "0.002", false)]
    [InlineData("recovery-ap-002", true, "0.68", "0.022", "0.001", false)]
    public async Task ClassifiesValidatedMeasurements(
        string name, bool operational, string utilization, string latency, string loss, bool expected)
    {
        var responses = BaselineResponses();
        responses["venue_ap_operational"] = ApVector(operational ? "1" : "0", "1", "1", "1");
        responses["venue_ap_channel_utilization_ratio"] = ApVector(utilization, "0.48", "0.41", "0.46");
        responses["venue_ap_management_latency_seconds"] = ApVector(latency, "0.016", "0.015", "0.017");
        responses["venue_ap_management_packet_loss_ratio"] = ApVector(loss, "0.001", "0.001", "0.002");

        var result = JsonSerializer.SerializeToElement(
            await CreateClient(responses).GetOperationsOverviewAsync(CancellationToken.None), JsonOptions);
        var ap = result.GetProperty("accessPoints")[0];

        Assert.True(ap.TryGetProperty("degraded", out var degraded), $"{name}: missing degraded field");
        Assert.Equal(expected, degraded.GetBoolean());
        Assert.Equal(expected ? 1 : 0, result.GetProperty("zones")[0].GetProperty("degradedAccessPoints").GetInt32());
        Assert.Equal(0, result.GetProperty("zones")[1].GetProperty("degradedAccessPoints").GetInt32());
    }

    [Fact]
    public async Task PeakKeepsAvailabilityAndClassifiesBothZonesWithSeparateAlerts()
    {
        var responses = BaselineResponses();
        responses["venue_ap_clients"] = ApVector("84", "70", "42", "47");
        responses["venue_ap_channel_utilization_ratio"] = ApVector("0.95", "0.88", "0.61", "0.66");
        responses["venue_ap_management_latency_seconds"] = ApVector("0.078", "0.062", "0.015", "0.019");
        responses["venue_ap_management_packet_loss_ratio"] = ApVector("0.017", "0.009", "0.001", "0.002");
        responses["zone:venue_ap_clients:sum"] = Vector(Sample("154", ("zone", "zone-a")), Sample("89", ("zone", "zone-b")));
        responses["ALERTS{alertname=\"VenueApDegraded\"}"] = Vector(
            Alert("VenueApDegraded", "pending", "ap-001", "zone-a"),
            Alert("VenueApDegraded", "firing", "ap-002", "zone-a"));
        var overview = await CreateClient(responses).GetOperationsOverviewAsync(CancellationToken.None);
        Assert.All(overview.AccessPoints, ap => Assert.True(ap.Operational));
        Assert.All(overview.AccessPoints, ap => Assert.Equal("inactive", ap.AlertState));
        Assert.Equal(new[] { 154, 89 }, overview.Zones.Select(zone => zone.Clients));
        Assert.All(overview.Zones, zone => Assert.Equal(1, zone.OperationalRatio));
        var result = JsonSerializer.SerializeToElement(overview, JsonOptions);
        Assert.Equal(new[] { true, true, false, false }, result.GetProperty("accessPoints").EnumerateArray().Select(ap => ap.GetProperty("degraded").GetBoolean()));
        Assert.Equal(new[] { "pending", "firing", "inactive", "inactive" }, result.GetProperty("accessPoints").EnumerateArray().Select(ap => ap.GetProperty("degradationAlertState").GetString()));
        Assert.Equal(2, result.GetProperty("zones")[0].GetProperty("degradedAccessPoints").GetInt32());
    }

    [Theory]
    [InlineData("unknown-ap")]
    [InlineData("wrong-zone")]
    [InlineData("duplicate")]
    [InlineData("invalid-state")]
    [InlineData("invalid-value")]
    public async Task RejectsInvalidDegradationAlerts(string defect)
    {
        var sample = Alert("VenueApDegraded", "pending", "ap-001", "zone-a");
        var responses = BaselineResponses();
        responses["ALERTS{alertname=\"VenueApDegraded\"}"] = defect switch
        {
            "unknown-ap" => Vector(Alert("VenueApDegraded", "pending", "ap-999", "zone-a")),
            "wrong-zone" => Vector(Alert("VenueApDegraded", "pending", "ap-001", "zone-b")),
            "duplicate" => Vector(sample, sample),
            "invalid-state" => Vector(Alert("VenueApDegraded", "unknown", "ap-001", "zone-a")),
            _ => Vector(Sample("0", ("ap_id", "ap-001"), ("zone", "zone-a"), ("alertstate", "pending")))
        };
        await Assert.ThrowsAsync<PrometheusQueryException>(() => CreateClient(responses).GetOperationsOverviewAsync(CancellationToken.None));
    }

    [Theory]
    [InlineData("venue_ap_channel_utilization_ratio", "missing")]
    [InlineData("venue_ap_management_latency_seconds", "missing")]
    [InlineData("venue_ap_management_packet_loss_ratio", "missing")]
    [InlineData("venue_ap_channel_utilization_ratio", "1.1")]
    [InlineData("venue_ap_management_latency_seconds", "-0.1")]
    [InlineData("venue_ap_management_packet_loss_ratio", "NaN")]
    public async Task InvalidRequiredMeasurementsStillFailInsteadOfBecomingHealthy(string metric, string value)
    {
        var responses = BaselineResponses();
        responses[metric] = value == "missing" ? Vector() : ApVector(value, value, value, value);
        await Assert.ThrowsAsync<PrometheusQueryException>(() => CreateClient(responses).GetOperationsOverviewAsync(CancellationToken.None));
    }

    [Fact]
    public async Task ExistingApDownAlertAndOfflineNullSemanticsRemainIntact()
    {
        var responses = BaselineResponses();
        responses["venue_ap_operational"] = ApVector("0", "1", "1", "1");
        responses["venue_ap_clients"] = ApVector("0", "35", "28", "31");
        responses["ALERTS{alertname=\"VenueApDown\"}"] = Vector(Alert("VenueApDown", "firing", "ap-001", "zone-a"));
        var ap = (await CreateClient(responses).GetOperationsOverviewAsync(CancellationToken.None)).AccessPoints[0];
        Assert.False(ap.Operational);
        Assert.Equal(0, ap.Clients);
        Assert.Null(ap.ChannelUtilizationRatio);
        Assert.Null(ap.ManagementLatencySeconds);
        Assert.Null(ap.ManagementPacketLossRatio);
        Assert.Equal("firing", ap.AlertState);
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private static Dictionary<string, string> BaselineResponses() => new()
    {
        ["venue_ap_operational"] = ApVector("1", "1", "1", "1"),
        ["venue_ap_clients"] = ApVector("42", "35", "28", "31"),
        ["venue_ap_channel_utilization_ratio"] = ApVector("0.55", "0.48", "0.41", "0.46"),
        ["venue_ap_management_latency_seconds"] = ApVector("0.018", "0.016", "0.015", "0.017"),
        ["venue_ap_management_packet_loss_ratio"] = ApVector("0.002", "0.001", "0.001", "0.002"),
        ["zone:venue_ap_operational:avg"] = Vector(Sample("1", ("zone", "zone-a")), Sample("1", ("zone", "zone-b"))),
        ["zone:venue_ap_clients:sum"] = Vector(Sample("77", ("zone", "zone-a")), Sample("59", ("zone", "zone-b"))),
        ["up{job=\"venue-ap-simulator\"}"] = Vector(Sample("1")),
        ["probe_success{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}"] = Vector(Sample("1")),
        ["probe_duration_seconds{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}"] = Vector(Sample("0.012")),
        ["probe_http_status_code{job=\"blackbox-http\",instance=\"http://venue-api:8080/health/live\"}"] = Vector(Sample("200")),
        ["ALERTS{alertname=\"VenueApDown\"}"] = Vector(),
        ["ALERTS{alertname=\"VenueApDegraded\"}"] = Vector()
    };

    private static object Alert(string name, string state, string ap, string zone) =>
        Sample("1", ("alertname", name), ("alertstate", state), ("ap_id", ap), ("zone", zone));
    private static object Sample(string value, params (string Key, string Value)[] labels) =>
        new { metric = labels.ToDictionary(x => x.Key, x => x.Value), value = new object[] { 1789140000, value } };
    private static string Vector(params object[] samples) =>
        JsonSerializer.Serialize(new { status = "success", data = new { resultType = "vector", result = samples } });
    private static string ApVector(params string[] values) => Vector(values.Select((value, i) =>
        Sample(value, ("ap_id", $"ap-{i + 1:000}"), ("zone", i < 2 ? "zone-a" : "zone-b"))).ToArray());
    private static PrometheusClient CreateClient(Dictionary<string, string> responses) =>
        new(new HttpClient(new Handler(responses)) { BaseAddress = new Uri("http://prometheus:9090") });
    private sealed class Handler(Dictionary<string, string> responses) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var expression = Uri.UnescapeDataString(request.RequestUri!.Query.Split("query=", 2)[1]);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(responses[expression], Encoding.UTF8, "application/json")
            });
        }
    }
}
