using System.Net;
using System.Text;
using System.Text.Json;
using VenueOps.Api;
using Xunit;
namespace VenueOps.Api.Tests;
public sealed class IncidentContextTests
{
    [Fact]
    public async Task CapturesActualBoundedAlertMetadataWithoutChangingOverviewContract()
    {
        var responses = BaselineResponses();
        responses["ALERTS{alertname=\"VenueApDegraded\"}"] = Vector(Sample("1", ("alertname", "VenueApDegraded"), ("alertstate", "pending"), ("ap_id", "ap-001"), ("zone", "zone-a"), ("severity", "warning"), ("telemetry_source", "simulated"), ("arbitrary", "not stored")));
        var capture = await CreateClient(responses).GetIncidentMonitoringCaptureAsync(CancellationToken.None);
        var alert = Assert.Single(capture.ActiveAlerts);
        Assert.Equal("pending", alert.State);
        Assert.Equal("warning", alert.Severity);
        Assert.Equal("simulated", alert.TelemetrySource);
        Assert.Equal("ap-001", alert.ApId);
        Assert.Equal("zone-a", alert.Zone);
        Assert.True(capture.CapturedAtUtc >= capture.Overview.GeneratedAtUtc);
        var json = JsonSerializer.Serialize(alert);
        Assert.DoesNotContain("arbitrary", json);
        var overview = JsonSerializer.SerializeToElement(await CreateClient(responses).GetOperationsOverviewAsync(CancellationToken.None), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(new[] { "accessPoints", "generatedAtUtc", "probe", "simulatorScrape", "zones" }, overview.EnumerateObject().Select(p => p.Name).Order());
    }
    [Theory]
    [InlineData("alertname")] [InlineData("severity")] [InlineData("telemetry_source")]
    public async Task MissingIncidentAlertMetadataFailsCaptureWithoutWeakeningOverview(string missing)
    {
        var labels = new Dictionary<string,string> { ["alertname"]="VenueApDown", ["alertstate"]="firing", ["ap_id"]="ap-001", ["zone"]="zone-a", ["severity"]="critical", ["telemetry_source"]="simulated" };
        labels.Remove(missing);
        var responses = BaselineResponses();
        responses["ALERTS{alertname=\"VenueApDown\"}"] = Vector(Sample("1", labels.Select(x => (x.Key,x.Value)).ToArray()));
        await Assert.ThrowsAsync<PrometheusQueryException>(() => CreateClient(responses).GetIncidentMonitoringCaptureAsync(CancellationToken.None));
        await CreateClient(responses).GetOperationsOverviewAsync(CancellationToken.None);
    }
    [Fact]
    public async Task NoActiveAlertProducesNoFabricatedOccurrence() => Assert.Empty((await CreateClient(BaselineResponses()).GetIncidentMonitoringCaptureAsync(CancellationToken.None)).ActiveAlerts);
    [Fact]
    public async Task MalformedRequiredTelemetryStillFails()
    {
        var responses=BaselineResponses(); responses["venue_ap_clients"]=Vector();
        await Assert.ThrowsAsync<PrometheusQueryException>(() => CreateClient(responses).GetIncidentMonitoringCaptureAsync(CancellationToken.None));
    }
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
