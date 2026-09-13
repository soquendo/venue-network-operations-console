using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using VenueOps.Api;
using Xunit;

namespace VenueOps.Api.Tests;

public sealed class IncidentDiscoveryTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private const string IntentJson = "\"title\":\"Issue\",\"accessPoints\":[{\"apId\":\"ap-001\",\"expectedCondition\":\"degraded\"}]";

    [Theory]
    [InlineData("")]
    [InlineData(",\"creationCommandId\":null")]
    [InlineData(",\"creationCommandId\":\"66ab97eb-7a85-4b62-872c-f4bec41e9ae1\"")]
    public void CreationAcceptsOmittedNullOrValidKey(string key)
    {
        var request = JsonSerializer.Deserialize<CreateIncidentRequest>("{" + IntentJson + key + "}", Json)!;
        request.Validate();
    }

    [Fact]
    public void EmptyCreationKeyIsDomainValidationFailure()
    {
        var request = JsonSerializer.Deserialize<CreateIncidentRequest>("{" + IntentJson + ",\"creationCommandId\":\"00000000-0000-0000-0000-000000000000\"}", Json)!;
        Assert.Throws<IncidentValidationException>(request.Validate);
    }

    [Fact]
    public void MalformedCreationKeyIsJsonValidationFailure() =>
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<CreateIncidentRequest>("{" + IntentJson + ",\"creationCommandId\":\"not-a-uuid\"}", Json));

    [Fact]
    public void ModelHasNullableGloballyUniqueCreationKeyWithoutConnecting()
    {
        using var db = new IncidentDbContext(new DbContextOptionsBuilder<IncidentDbContext>().UseNpgsql("Host=unused;Database=unused").Options);
        var entity = db.Model.FindEntityType(typeof(Incident))!;
        var property = entity.FindProperty("CreationCommandId");
        Assert.NotNull(property);
        Assert.True(property.IsNullable);
        Assert.Equal(typeof(Guid?), property.ClrType);
        Assert.Equal("uuid", property.GetColumnType());
        var index = Assert.Single(entity.GetIndexes(), i => i.Properties.Count == 1 && i.Properties[0] == property);
        Assert.True(index.IsUnique);
        Assert.Equal("IX_Incidents_CreationCommandId", index.GetDatabaseName());
        Assert.Equal("\"CreationCommandId\" IS NOT NULL", index.GetFilter());
    }

    [Fact]
    public void CreationKeyIsStoredWithoutChangingTheDetailContract()
    {
        var request = Request();
        var incident = New(request);
        Assert.Equal(request.CreationCommandId, incident.CreationCommandId);
        var json = JsonSerializer.SerializeToElement(incident.ToResponse(), Json);
        Assert.False(json.TryGetProperty("creationCommandId", out _));
        Assert.Equal(1, json.GetProperty("version").GetInt64());
        Assert.Equal("Open", json.GetProperty("status").GetString());
        Assert.Equal("Created", json.GetProperty("events")[0].GetProperty("kind").GetString());
    }

    [Fact]
    public void MatchingUsesOriginalResponderAndCapturedConditionsBeyondTheNewestPage()
    {
        var request = Request();
        var incident = New(request);
        var created = incident.Events.Single();
        var evidence = JsonSerializer.Serialize(incident.ToResponse().MonitoringEvidence, Json);
        incident.Apply(IncidentWorkflow.Responder(new(Guid.NewGuid(), 1, "Other team")), Time);
        incident.Apply(IncidentWorkflow.Transition(new(Guid.NewGuid(), 2, "Resolved", "Recovered")), Time);
        for (var n = 0; n < 105; n++)
            incident.Apply(IncidentWorkflow.Note(new(Guid.NewGuid(), incident.Version, "Follow-up " + n)), Time);
        Assert.DoesNotContain(incident.ToResponse().Events, e => e.Kind == "Created");
        Assert.True(incident.MatchesCreationIntent(request, created));
        Assert.False(incident.MatchesCreationIntent(request with { ResponderLabel = "Other team" }, created));
        Assert.Equal(evidence, JsonSerializer.Serialize(incident.ToResponse().MonitoringEvidence, Json));
        Assert.Equal("Resolved", incident.ToResponse().Status);
        Assert.Equal(108, incident.ToResponse().Version);
    }

    [Fact]
    public void ReorderedSelectionAndOuterWhitespaceHaveTheSameIntent()
    {
        var request = Request();
        var incident = New(request);
        Assert.True(incident.MatchesCreationIntent(request with
        {
            Title = "  Zone issue  ", ResponderLabel = "  Initial team  ",
            AccessPoints = request.AccessPoints!.Reverse().ToArray()
        }, incident.Events.Single()));
    }

    [Theory]
    [InlineData(null)] [InlineData("")] [InlineData("  ")]
    public void BlankInitialResponderMatchesNull(string? responder)
    {
        var request = Request() with { ResponderLabel = null };
        var incident = New(request);
        Assert.True(incident.MatchesCreationIntent(request with { ResponderLabel = responder }, incident.Events.Single()));
    }

    [Theory]
    [InlineData("title")] [InlineData("case")] [InlineData("spacing")]
    [InlineData("responder")] [InlineData("condition")] [InlineData("ap")]
    [InlineData("count")]
    public void ChangedIntentDoesNotMatch(string changed)
    {
        var original = Request();
        var incident = New(original);
        var request = changed switch
        {
            "title" => original with { Title = "Different issue" },
            "case" => original with { Title = "zone issue" },
            "spacing" => original with { Title = "Zone  issue" },
            "responder" => original with { ResponderLabel = null },
            "condition" => original with { AccessPoints = [new("ap-001", "offline"), new("ap-002", "degraded")] },
            "ap" => original with { AccessPoints = [new("AP-001", "degraded"), new("ap-002", "degraded")] },
            _ => original with { AccessPoints = [new("ap-001", "degraded")] }
        };
        Assert.False(incident.MatchesCreationIntent(request, incident.Events.Single()));
    }

    [Fact]
    public void OfflineExpectedConditionComesFromCapturedAvailability()
    {
        var request = Request() with { AccessPoints = [new("ap-001", "offline")] };
        var incident = New(request);
        Assert.True(incident.MatchesCreationIntent(request, incident.Events.Single()));
        Assert.False(incident.MatchesCreationIntent(request with { AccessPoints = [new("ap-001", "degraded")] }, incident.Events.Single()));
    }

    [Fact]
    public void UnrelatedCreationKeysDoNotCorrelateIdenticalIntent()
    {
        var one = New(Request());
        var two = New(Request());
        Assert.NotEqual(one.CreationCommandId, two.CreationCommandId);
        Assert.True(one.MatchesCreationIntent(Request(), one.Events.Single()));
        Assert.Single(one.Events);
        Assert.Single(two.Events);
    }

    [Fact]
    public void CreationConflictsExposeStableSeparateCodes()
    {
        var key = Assert.IsType<ProblemHttpResult>(IncidentEndpoints.CreationConflict(new("Different intent")));
        Assert.Equal(409, key.StatusCode);
        Assert.Equal("creation_command_conflict", key.ProblemDetails.Extensions["code"]);
        var condition = Assert.IsType<ProblemHttpResult>(IncidentEndpoints.ConditionConflict(new("Recovered")));
        Assert.Equal(409, condition.StatusCode);
        Assert.Equal("condition_changed", condition.ProblemDetails.Extensions["code"]);
    }

    [Theory]
    [InlineData(null)] [InlineData("Open")] [InlineData("Investigating")]
    [InlineData("Monitoring")] [InlineData("Resolved")]
    public void ListAcceptsSupportedStatus(string? status) => new IncidentListRequest(status).Validate();

    [Theory]
    [InlineData("")] [InlineData("open")] [InlineData("Unknown")] [InlineData(" Open ")]
    public void ListRejectsUnsupportedStatus(string status) =>
        Assert.Throws<IncidentValidationException>(() => new IncidentListRequest(status).Validate());

    [Theory]
    [InlineData(0)] [InlineData(-1)]
    public void ListRejectsNonpositiveCursor(long cursor) =>
        Assert.Throws<IncidentValidationException>(() => new IncidentListRequest(BeforeId: cursor).Validate());

    [Theory]
    [InlineData("")] [InlineData(" ")]
    public void ListRejectsBlankZone(string zone) =>
        Assert.Throws<IncidentValidationException>(() => new IncidentListRequest(Zone: zone).Validate());

    [Theory]
    [InlineData("\0")] [InlineData("zone-a\0")] [InlineData("zone\0-a")]
    public void ListRejectsNulZoneBeforeQueryConstruction(string zone)
    {
        var request = new IncidentListRequest(Zone: zone);
        Assert.Throws<IncidentValidationException>(request.Validate);
        using var db = Database();
        Assert.Throws<IncidentValidationException>(() => IncidentService.ListQuery(db.Incidents, request));
    }

    [Theory]
    [InlineData("zone-a")] [InlineData("unknown-zone")]
    public void ListAcceptsSyntacticallyValidZoneWithoutInventoryLookup(string zone) =>
        new IncidentListRequest(Zone: zone).Validate();

    [Fact]
    public void ListValidatesZoneLengthAndAcceptsUnknownBoundedZones()
    {
        new IncidentListRequest(Zone: new string('x', 64), BeforeId: long.MaxValue).Validate();
        Assert.Throws<IncidentValidationException>(() => new IncidentListRequest(Zone: new string('x', 65)).Validate());
    }

    [Theory]
    [InlineData(0, false, null)] [InlineData(1, false, null)]
    [InlineData(50, false, null)] [InlineData(51, true, 2L)]
    public void ListPageHasExactBoundsAndExclusiveNextCursor(int count, bool more, long? cursor)
    {
        var rows = Enumerable.Range(1, count).Reverse().Select(n => Summary(n)).ToArray();
        var page = IncidentListResponse.Page(rows);
        Assert.Equal(Math.Min(50, count), page.Items.Count);
        Assert.Equal(more, page.HasMore);
        Assert.Equal(cursor, page.NextBeforeId);
        Assert.Equal(rows.Take(50), page.Items);
    }

    [Fact]
    public void SummarySerializationDoesNotExposeEvidenceOrChronology()
    {
        var json = JsonSerializer.SerializeToElement(Summary(123), Json);
        Assert.Equal("INC-000123", json.GetProperty("number").GetString());
        Assert.Equal(new[] { "affectedAccessPointCount", "createdAtUtc", "id", "number", "resolvedAtUtc", "responderLabel", "status", "title", "version", "zone" },
            json.EnumerateObject().Select(p => p.Name).Order().ToArray());
    }

    [Fact]
    public void ListQueryCombinesFiltersAndOrdersIdsRatherThanTimestamps()
    {
        using var db = Database();
        var incidents = Enumerable.Range(1, 60).Select(n =>
        {
            var incident = New(Request() with { AccessPoints = [new(n % 2 == 0 ? "ap-001" : "ap-003", "degraded")] });
            db.Entry(incident).Property(i => i.Id).CurrentValue = n;
            if (n % 3 == 0) incident.Apply(IncidentWorkflow.Transition(new(Guid.NewGuid(), 1, "Monitoring")), Time);
            return incident;
        }).ToArray();
        var rows = IncidentService.ListQuery(incidents.AsQueryable(), new("Monitoring", "zone-a", 50)).ToArray();
        Assert.Equal(new long[] { 48, 42, 36, 30, 24, 18, 12, 6 }, rows.Select(r => r.Id));
        Assert.All(rows, r => { Assert.Equal(2, r.Version); Assert.Equal(1, r.AffectedAccessPointCount); });
        Assert.Equal(51, IncidentService.ListQuery(incidents.AsQueryable(), new()).Count());
        Assert.Empty(IncidentService.ListQuery(incidents.AsQueryable(), new(Zone: "ZONE-A")));
    }

    [Fact]
    public void ProviderTranslatesBoundedSummaryProjectionWithoutLoadingGraphs()
    {
        using var db = Database();
        var sql = IncidentService.ListQuery(db.Incidents, new("Open", "zone-a", 123)).ToQueryString();
        Assert.Contains("ORDER BY", sql);
        Assert.Contains("DESC", sql);
        Assert.Contains("LIMIT", sql);
        Assert.Contains("count(*)", sql);
        Assert.DoesNotContain("IncidentEvents", sql);
        Assert.DoesNotContain("ChannelUtilization", sql);
        Assert.DoesNotContain("ManagementLatency", sql);
    }

    private static readonly DateTimeOffset Time = DateTimeOffset.Parse("2026-09-13T01:00:00Z");
    private static IncidentDbContext Database() => new(new DbContextOptionsBuilder<IncidentDbContext>().UseNpgsql("Host=unused;Database=unused").Options);
    private static IncidentSummary Summary(long id) => new(id, "Issue", "Open", "zone-a", null, Time, null, 1, 2);
    private static CreateIncidentRequest Request() => new("Zone issue", [new("ap-001", "degraded"), new("ap-002", "degraded")], "Initial team", Guid.NewGuid());
    private static Incident New(CreateIncidentRequest request)
    {
        var aps = request.AccessPoints!.Select(ap => new OperationsAccessPointObservation(ap.ApId!, ap.ApId == "ap-003" ? "zone-b" : "zone-a",
            ap.ExpectedCondition != "offline", ap.ExpectedCondition == "offline" ? 0 : 84,
            ap.ExpectedCondition == "offline" ? null : .95, ap.ExpectedCondition == "offline" ? null : .078,
            ap.ExpectedCondition == "offline" ? null : .017, "inactive", ap.ExpectedCondition == "degraded", "inactive", "simulated", Time)).ToArray();
        return Incident.Create(request, new(new(Time, aps, [], new("probe", true, .01, 200, "measured", Time), new(true, 1, "measured", Time)), [], Time), Time);
    }
}
