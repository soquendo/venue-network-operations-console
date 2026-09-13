using System.Text.Json;
using VenueOps.Api;
using Xunit;

namespace VenueOps.Api.Tests;

public sealed class IncidentTests
{
    private static readonly DateTimeOffset Captured = DateTimeOffset.Parse("2026-09-13T01:00:00Z");

    [Fact]
    public void CreationExposesInitialWorkflowVersionAndChronology()
    {
        var incident = Incident.Create(new("Issue", [new("ap-001", "degraded")], "Venue team"), Capture([Ap("ap-001")]), Captured);
        var json = JsonSerializer.SerializeToElement(incident.ToResponse(), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.True(json.TryGetProperty("version", out var version));
        Assert.Equal(1, version.GetInt64());
        Assert.Equal(JsonValueKind.Null, json.GetProperty("resolvedAtUtc").ValueKind);
        Assert.False(json.GetProperty("hasEarlierEvents").GetBoolean());
        Assert.Equal(JsonValueKind.Null, json.GetProperty("nextBeforeEventSequence").ValueKind);
        var created = json.GetProperty("events")[0];
        Assert.Equal(1, created.GetProperty("sequence").GetInt64());
        Assert.Equal("Open", created.GetProperty("toStatus").GetString());
        Assert.Equal("Venue team", created.GetProperty("responderLabel").GetString());
        Assert.Equal(JsonValueKind.Null, created.GetProperty("commandId").ValueKind);
    }

    [Fact]
    public void CreatesOneOpenIncidentWithImmutableEvidenceAndOneCreatedEvent()
    {
        var points = new[] { Ap("ap-001"), Ap("ap-002") };
        var capture = Capture(points);
        var request = new CreateIncidentRequest("  Zone degradation  ",
            [new("ap-001", "degraded"), new("ap-002", "degraded")], "  Venue team  ");
        var incident = Incident.Create(request, capture, Captured.AddSeconds(1));
        points[0] = Ap("ap-001", operational: false, degraded: false);
        var result = incident.ToResponse();
        Assert.Equal("Open", result.Status);
        Assert.Equal("Zone degradation", result.Title);
        Assert.Equal("Venue team", result.ResponderLabel);
        Assert.Equal("zone-a", result.Zone);
        Assert.Equal(Captured.AddSeconds(1), result.CreatedAtUtc);
        Assert.Equal(Captured, result.MonitoringEvidence.CapturedAtUtc);
        Assert.Equal(Captured.AddMilliseconds(-1), result.MonitoringEvidence.GeneratedAtUtc);
        Assert.Equal(2, result.MonitoringEvidence.AccessPoints.Count);
        Assert.True(result.MonitoringEvidence.AccessPoints[0].Operational);
        Assert.Equal(84, result.MonitoringEvidence.AccessPoints[0].Clients);
        Assert.Equal("Created", Assert.Single(result.Events).Kind);
        Assert.Equal(result.CreatedAtUtc, result.Events[0].OccurredAtUtc);
    }

    [Fact]
    public void NormalizesCreationTimesToPostgresMicrosecondsBeforeReturningThem()
    {
        var time = Captured.AddTicks(17);
        var capture = Capture([Ap("ap-001")]) with { CapturedAtUtc = time };
        var result = Incident.Create(new("Issue", [new("ap-001", "degraded")]), capture, time).ToResponse();
        Assert.Equal(Captured.AddTicks(10), result.CreatedAtUtc);
        Assert.Equal(result.CreatedAtUtc, result.MonitoringEvidence.CapturedAtUtc);
        Assert.Equal(result.CreatedAtUtc, result.Events[0].OccurredAtUtc);
    }

    [Fact]
    public void OfflineEvidencePreservesZeroAndUnavailableMeasurements()
    {
        var ap = Ap("ap-001", operational: false, degraded: false) with
        { Clients = 0, ChannelUtilizationRatio = null, ManagementLatencySeconds = null, ManagementPacketLossRatio = null, AlertState = "firing" };
        var alert = new IncidentAlertObservation("VenueApDown", "firing", "critical", "simulated", "ap-001", "zone-a", Captured);
        var incident = Incident.Create(new("Offline", [new("ap-001", "offline")]),
            Capture([ap]) with { ActiveAlerts = [alert] }, Captured);
        var context = Assert.Single(incident.ToResponse().MonitoringEvidence.AccessPoints);
        Assert.Equal(0, context.Clients);
        Assert.Null(context.ChannelUtilizationRatio);
        Assert.Null(context.ManagementLatencySeconds);
        Assert.Null(context.ManagementPacketLossRatio);
        Assert.False(context.Operational);
        Assert.False(context.Degraded);
        Assert.Equal(alert, context.DownAlert);
        Assert.Null(context.DegradationAlert);
    }

    [Theory]
    [InlineData(null)] [InlineData("")] [InlineData("   ")]
    public void RejectsMissingTitle(string? title) =>
        Assert.Throws<IncidentValidationException>(() => new CreateIncidentRequest(title, [new("ap-001", "degraded")]).Validate());

    [Theory]
    [InlineData("title")] [InlineData("responder")] [InlineData("ap")]
    public void RejectsOversizedInput(string field)
    {
        var request = new CreateIncidentRequest(field == "title" ? new string('x', 201) : "Issue",
            [new(field == "ap" ? new string('x', 65) : "ap-001", "degraded")],
            field == "responder" ? new string('x', 101) : null);
        Assert.Throws<IncidentValidationException>(request.Validate);
    }

    [Fact]
    public void AcceptsDocumentedInputLengthLimits() =>
        new CreateIncidentRequest(new string('x', 200), [new("ap-001", "degraded")], new string('x', 100)).Validate();

    [Theory]
    [InlineData("healthy")] [InlineData("Degraded")] [InlineData("")] [InlineData(null)]
    public void RejectsUnsupportedExpectedCondition(string? condition) =>
        Assert.Throws<IncidentValidationException>(() => new CreateIncidentRequest("Issue", [new("ap-001", condition)]).Validate());

    [Fact]
    public void RejectsMissingSelection() => Assert.Throws<IncidentValidationException>(() => new CreateIncidentRequest("Issue", null).Validate());
    [Fact]
    public void RejectsEmptySelection() => Assert.Throws<IncidentValidationException>(() => new CreateIncidentRequest("Issue", []).Validate());
    [Fact]
    public void RejectsNullSelectionEntry() => Assert.Throws<IncidentValidationException>(() => new CreateIncidentRequest("Issue", [null!]).Validate());
    [Fact]
    public void RejectsDuplicateAp() => Assert.Throws<IncidentValidationException>(() => new CreateIncidentRequest("Issue", [new("ap-001", "offline"), new("ap-001", "degraded")]).Validate());
    [Fact]
    public void RejectsUnknownAp() => Assert.Throws<IncidentValidationException>(() => Incident.Create(new("Issue", [new("ap-999", "degraded")]), Capture([Ap("ap-001")]), Captured));
    [Fact]
    public void RejectsMixedZones() => Assert.Throws<IncidentValidationException>(() => Incident.Create(new("Issue", [new("ap-001", "degraded"), new("ap-003", "degraded")]), Capture([Ap("ap-001"), Ap("ap-003", "zone-b")]), Captured));

    [Theory]
    [InlineData("degraded", true, false)]
    [InlineData("degraded", false, false)]
    [InlineData("offline", true, true)]
    [InlineData("offline", true, false)]
    public void ChangedConditionIsAConflict(string expected, bool operational, bool degraded) =>
        Assert.Throws<IncidentConditionChangedException>(() => Incident.Create(new("Issue", [new("ap-001", expected)]), Capture([Ap("ap-001", operational: operational, degraded: degraded)]), Captured));

    [Fact]
    public void FailedScrapeCannotCreateFromLookbackValues() =>
        Assert.Throws<PrometheusQueryException>(() => Incident.Create(new("Issue", [new("ap-001", "degraded")]), Capture([Ap("ap-001")], false), Captured));

    [Fact]
    public void DegradationWithoutAnActiveAlertIsValid()
    {
        var result = Incident.Create(new("Issue", [new("ap-001", "degraded")]), Capture([Ap("ap-001")]), Captured).ToResponse();
        Assert.Null(result.MonitoringEvidence.AccessPoints[0].DegradationAlert);
        Assert.Equal("inactive", result.MonitoringEvidence.AccessPoints[0].DegradationAlertState);
        Assert.Null(result.ResponderLabel);
    }

    [Theory]
    [InlineData(1, "INC-000001")] [InlineData(999999, "INC-999999")] [InlineData(1000000, "INC-1000000")]
    public void FormatsDatabaseIdentityWithoutTruncation(long id, string expected) => Assert.Equal(expected, Incident.FormatNumber(id));

    [Theory]
    [InlineData("clients")] [InlineData("zone")] [InlineData("alertState")] [InlineData("observedAtUtc")]
    public void RequestRejectsClientSuppliedMonitoringFields(string field) =>
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<CreateIncidentRequest>(
            "{\"title\":\"Issue\",\"accessPoints\":[{\"apId\":\"ap-001\",\"expectedCondition\":\"offline\"}],\"" + field + "\":0}", new JsonSerializerOptions(JsonSerializerDefaults.Web)));

    private static OperationsAccessPointObservation Ap(string id, string zone = "zone-a", bool operational = true, bool degraded = true) =>
        new(id, zone, operational, 84, .95, .078, .017, "inactive", degraded, "inactive", "simulated", Captured.AddSeconds(-1));
    private static IncidentMonitoringCapture Capture(OperationsAccessPointObservation[] points, bool up = true) =>
        new(new(Captured.AddMilliseconds(-1), points, [], new("probe", true, .01, 200, "measured", Captured), new(up, up ? 1 : 0, "measured", Captured)), [], Captured);
}
