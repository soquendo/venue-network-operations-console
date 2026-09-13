using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using VenueOps.Api;
using Xunit;

namespace VenueOps.Api.Tests;

public sealed class IncidentWorkflowTests
{
    private static readonly DateTimeOffset Time = DateTimeOffset.Parse("2026-09-13T12:00:00Z");
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [Theory]
    [InlineData("Open", "Investigating")]
    [InlineData("Open", "Monitoring")]
    [InlineData("Open", "Resolved")]
    [InlineData("Investigating", "Monitoring")]
    [InlineData("Investigating", "Resolved")]
    [InlineData("Monitoring", "Investigating")]
    [InlineData("Monitoring", "Resolved")]
    [InlineData("Resolved", "Investigating")]
    public void AllowedTransitionsCommitOneOrderedEvent(string from, string to)
    {
        var incident = At(from);
        var version = incident.Version;
        var count = incident.Events.Count;
        var entry = incident.Apply(Transition(incident, to, "  Recorded reason  "), Time.AddTicks(17));
        Assert.Equal(to, incident.Status);
        Assert.Equal(version + 1, incident.Version);
        Assert.Equal(incident.Version, entry.Sequence);
        Assert.Equal(count + 1, incident.Events.Count);
        Assert.Equal("StatusChanged", entry.Kind);
        Assert.Equal(from, entry.FromStatus);
        Assert.Equal(to, entry.ToStatus);
        Assert.Equal("Recorded reason", entry.Text);
        Assert.Equal(Time.AddTicks(10), entry.OccurredAtUtc);
        Assert.Equal(to == "Resolved" ? entry.OccurredAtUtc : (DateTimeOffset?)null, incident.ResolvedAtUtc);
    }

    [Theory]
    [InlineData("Open", "Open")]
    [InlineData("Investigating", "Open")]
    [InlineData("Investigating", "Investigating")]
    [InlineData("Monitoring", "Open")]
    [InlineData("Monitoring", "Monitoring")]
    [InlineData("Resolved", "Open")]
    [InlineData("Resolved", "Monitoring")]
    [InlineData("Resolved", "Resolved")]
    public void ForbiddenTransitionsLeaveEverythingUnchanged(string from, string to)
    {
        var incident = At(from);
        var before = Serialize(incident.ToResponse());
        var command = Transition(incident, to, "Reason");
        var error = Assert.Throws<IncidentWorkflowConflictException>(() => incident.Apply(command, Time));
        Assert.Equal("state_conflict", error.Code);
        Assert.Equal(before, Serialize(incident.ToResponse()));
        Assert.DoesNotContain(incident.Events, e => e.CommandId == command.CommandId);
    }

    [Theory]
    [InlineData(null)] [InlineData("")] [InlineData("resolved")] [InlineData("Unknown")]
    public void UnknownStatusIsInvalidInput(string? status) =>
        Assert.Throws<IncidentValidationException>(() => IncidentWorkflow.Transition(new(Guid.NewGuid(), 1, status, "Reason")));

    [Theory]
    [InlineData("Open", "Resolved")]
    [InlineData("Investigating", "Resolved")]
    [InlineData("Monitoring", "Resolved")]
    [InlineData("Resolved", "Investigating")]
    public void ResolutionAndReopeningRequireText(string from, string to)
    {
        var incident = At(from);
        var before = Serialize(incident.ToResponse());
        Assert.Throws<IncidentValidationException>(() => incident.Apply(Transition(incident, to, " \n "), Time));
        Assert.Equal(before, Serialize(incident.ToResponse()));
    }

    [Fact]
    public void OrdinaryTransitionsNeedNoNoteAndMonitoringIsOptional()
    {
        var incident = New();
        var entry = incident.Apply(Transition(incident, "Investigating"), Time);
        Assert.Null(entry.Text);
        incident.Apply(Transition(incident, "Resolved", "Understood brief outage"), Time);
        Assert.Equal("Resolved", incident.Status);
        Assert.DoesNotContain(incident.Events, e => e.ToStatus == "Monitoring");
    }

    [Fact]
    public void ReopenPreservesOriginalResolutionAndCreationEvidence()
    {
        var incident = New();
        var evidence = Serialize(incident.ToResponse().MonitoringEvidence);
        var created = Serialize(incident.Events[0].ToResponse());
        var resolution = incident.Apply(Transition(incident, "Resolved", "Recovered"), Time.AddSeconds(1));
        var original = Serialize(resolution.ToResponse());
        incident.Apply(Note(incident, "Follow-up"), Time.AddSeconds(2));
        Assert.Equal(resolution.OccurredAtUtc, incident.ResolvedAtUtc);
        incident.Apply(Transition(incident, "Investigating", "Condition returned"), Time.AddSeconds(3));
        Assert.Null(incident.ResolvedAtUtc);
        Assert.Equal(original, Serialize(resolution.ToResponse()));
        Assert.Equal(created, Serialize(incident.Events[0].ToResponse()));
        Assert.Equal(evidence, Serialize(incident.ToResponse().MonitoringEvidence));
        Assert.Equal("Issue", incident.Title);
        Assert.Equal("zone-a", incident.Zone);
        Assert.Equal(Time, incident.CreatedAtUtc);
    }

    [Theory]
    [InlineData("Open")] [InlineData("Investigating")] [InlineData("Monitoring")] [InlineData("Resolved")]
    public void NotesAreAllowedInEveryStateAndOnlyAdvanceVersion(string status)
    {
        var incident = At(status);
        var before = incident.ToResponse();
        var entry = incident.Apply(Note(incident, "  First line\n  second line  "), Time);
        Assert.Equal(before.Version + 1, incident.Version);
        Assert.Equal("NoteAdded", entry.Kind);
        Assert.Equal("First line\n  second line", entry.Text);
        Assert.Equal(before.Status, incident.Status);
        Assert.Equal(before.ResponderLabel, incident.ResponderLabel);
        Assert.Equal(before.ResolvedAtUtc, incident.ResolvedAtUtc);
        Assert.Equal(Serialize(before.MonitoringEvidence), Serialize(incident.ToResponse().MonitoringEvidence));
    }

    [Theory]
    [InlineData(null)] [InlineData("")] [InlineData(" \r\n ")]
    public void EmptyNotesRejected(string? text) =>
        Assert.Throws<IncidentValidationException>(() => IncidentWorkflow.Note(new(Guid.NewGuid(), 1, text)));

    [Fact]
    public void RawBoundsAreEnforcedBeforeTrimming()
    {
        Assert.Throws<IncidentValidationException>(() => IncidentWorkflow.Note(new(Guid.NewGuid(), 1, " " + new string('x', 2000))));
        Assert.Throws<IncidentValidationException>(() => IncidentWorkflow.Transition(new(Guid.NewGuid(), 1, "Resolved", new string('x', 2001))));
        Assert.Throws<IncidentValidationException>(() => IncidentWorkflow.Responder(new(Guid.NewGuid(), 1, new string('x', 101))));
        Assert.Equal(2000, IncidentWorkflow.Note(new(Guid.NewGuid(), 1, new string('x', 2000))).Text!.Length);
        Assert.Equal(2000, IncidentWorkflow.Transition(new(Guid.NewGuid(), 1, "Resolved", new string('x', 2000))).Text!.Length);
        Assert.Equal(100, IncidentWorkflow.Responder(new(Guid.NewGuid(), 1, new string('x', 100))).ResponderLabel!.Length);
    }

    [Theory]
    [InlineData("Open")] [InlineData("Investigating")] [InlineData("Monitoring")]
    public void ResponderSetChangeClearPreservesBeforeAndAfter(string status)
    {
        var incident = At(status);
        var initial = incident.Events[0].ResponderLabel;
        foreach (var value in new string?[] { "  Network Operations  ", "On-call technician", null })
        {
            var previous = incident.ResponderLabel;
            var version = incident.Version;
            var entry = incident.Apply(Responder(incident, value), Time);
            Assert.Equal("ResponderChanged", entry.Kind);
            Assert.Equal(previous, entry.PreviousResponderLabel);
            Assert.Equal(value?.Trim(), entry.ResponderLabel);
            Assert.Equal(entry.ResponderLabel, incident.ResponderLabel);
            Assert.Equal(version + 1, incident.Version);
        }
        Assert.Equal(initial, incident.Events[0].ResponderLabel);
    }

    [Theory]
    [InlineData(null)] [InlineData("Team")] [InlineData("  ")]
    public void ResolvedResponderMutationsAreStateConflicts(string? value)
    {
        var incident = At("Resolved");
        Assert.Equal("state_conflict", Assert.Throws<IncidentWorkflowConflictException>(() => incident.Apply(Responder(incident, value), Time)).Code);
    }

    [Fact]
    public void SameNormalizedResponderIsConflictAndBlankClears()
    {
        var incident = New();
        Assert.Equal("responder_unchanged", Assert.Throws<IncidentWorkflowConflictException>(() => incident.Apply(Responder(incident, "  Original team  "), Time)).Code);
        incident.Apply(Responder(incident, " \n "), Time);
        Assert.Null(incident.ResponderLabel);
        Assert.Equal("responder_unchanged", Assert.Throws<IncidentWorkflowConflictException>(() => incident.Apply(Responder(incident, null), Time)).Code);
    }

    [Fact]
    public void ResponderJsonMustBePresentButMayBeExplicitNull()
    {
        var prefix = "{\"commandId\":\"" + Guid.NewGuid() + "\",\"expectedVersion\":1";
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ChangeIncidentResponderRequest>(prefix + "}", Json));
        var request = JsonSerializer.Deserialize<ChangeIncidentResponderRequest>(prefix + ",\"responderLabel\":null}", Json)!;
        Assert.Null(IncidentWorkflow.Responder(request).ResponderLabel);
    }

    [Fact]
    public void RequestsRejectUnknownFieldsAndMalformedIds()
    {
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<AddIncidentNoteRequest>("{\"commandId\":\"bad\",\"expectedVersion\":1,\"text\":\"note\"}", Json));
        var prefix = "{\"commandId\":\"" + Guid.NewGuid() + "\",\"expectedVersion\":1,";
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<AddIncidentNoteRequest>(prefix + "\"text\":\"note\",\"author\":\"fake\"}", Json));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<TransitionIncidentRequest>(prefix + "\"status\":\"Monitoring\",\"zone\":\"bad\"}", Json));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ChangeIncidentResponderRequest>(prefix + "\"responderLabel\":null,\"userId\":1}", Json));
    }

    [Theory]
    [InlineData(0)] [InlineData(-1)]
    public void AllCommandsRequirePositiveVersion(long version)
    {
        Assert.Throws<IncidentValidationException>(() => IncidentWorkflow.Note(new(Guid.NewGuid(), version, "Note")));
        Assert.Throws<IncidentValidationException>(() => IncidentWorkflow.Transition(new(Guid.NewGuid(), version, "Monitoring", null)));
        Assert.Throws<IncidentValidationException>(() => IncidentWorkflow.Responder(new(Guid.NewGuid(), version, null)));
    }

    [Fact]
    public void AllCommandsRequireNonemptyId()
    {
        Assert.Throws<IncidentValidationException>(() => IncidentWorkflow.Note(new(Guid.Empty, 1, "Note")));
        Assert.Throws<IncidentValidationException>(() => IncidentWorkflow.Transition(new(Guid.Empty, 1, "Monitoring", null)));
        Assert.Throws<IncidentValidationException>(() => IncidentWorkflow.Responder(new(Guid.Empty, 1, null)));
    }

    [Fact]
    public void StaleCommandChangesNothingAndReservesNoId()
    {
        var incident = New();
        var stale = Note(incident, "Stale");
        incident.Apply(Note(incident, "Winner"), Time);
        var before = Serialize(incident.ToResponse());
        var error = Assert.Throws<IncidentWorkflowConflictException>(() => incident.Apply(stale, Time));
        Assert.Equal("version_conflict", error.Code);
        Assert.Equal(2, error.CurrentVersion);
        Assert.Equal("Open", error.CurrentStatus);
        Assert.Equal(before, Serialize(incident.ToResponse()));
        Assert.DoesNotContain(incident.Events, e => e.CommandId == stale.CommandId);
    }

    [Fact]
    public void CommittedNoteMatchesNormalizedIntentAndReceiptNeverDrifts()
    {
        var incident = New();
        var id = Guid.NewGuid();
        var command = IncidentWorkflow.Note(new(id, 1, "  A note  "));
        var entry = incident.Apply(command, Time);
        var receipt = Serialize(entry.ToReceipt());
        Assert.True(entry.Matches(IncidentWorkflow.Note(new(id, 1, "A note"))));
        Assert.False(entry.Matches(IncidentWorkflow.Note(new(id, 1, "Different"))));
        Assert.False(entry.Matches(IncidentWorkflow.Note(new(id, 2, "A note"))));
        Assert.False(entry.Matches(IncidentWorkflow.Note(new(Guid.NewGuid(), 1, "A note"))));
        Assert.False(entry.Matches(IncidentWorkflow.Transition(new(id, 1, "Monitoring", "A note"))));
        incident.Apply(Transition(incident, "Resolved", "Finished"), Time.AddSeconds(1));
        Assert.Equal(receipt, Serialize(entry.ToReceipt()));
        Assert.Equal(2, entry.ToReceipt().Version);
    }

    [Fact]
    public void TransitionAndResponderReplayCompareTheirTypedPayloads()
    {
        var incident = New();
        var command = Transition(incident, "Monitoring", " Observing ");
        var entry = incident.Apply(command, Time);
        Assert.True(entry.Matches(IncidentWorkflow.Transition(new(command.CommandId, 1, "Monitoring", "Observing"))));
        Assert.False(entry.Matches(IncidentWorkflow.Transition(new(command.CommandId, 1, "Investigating", "Observing"))));
        Assert.False(entry.Matches(IncidentWorkflow.Transition(new(command.CommandId, 1, "Monitoring", null))));
        command = Responder(incident, null);
        entry = incident.Apply(command, Time);
        Assert.True(entry.Matches(IncidentWorkflow.Responder(new(command.CommandId, 2, "  "))));
        Assert.False(entry.Matches(IncidentWorkflow.Responder(new(command.CommandId, 2, "Team"))));
    }

    [Fact]
    public void ChronologyPagesAreBoundedOrderedAndVersionFenced()
    {
        var incident = New();
        for (var n = 0; n < 205; n++) incident.Apply(Note(incident, "Note " + n), Time);
        var first = incident.ToResponse();
        Assert.Equal(206, first.Version);
        Assert.Equal(Enumerable.Range(107, 100).Select(n => (long)n), first.Events.Select(e => e.Sequence));
        Assert.True(first.HasEarlierEvents);
        Assert.Equal(107, first.NextBeforeEventSequence);
        var middle = incident.ToResponse(beforeEventSequence: first.NextBeforeEventSequence);
        var last = incident.ToResponse(beforeEventSequence: middle.NextBeforeEventSequence);
        Assert.Equal(Enumerable.Range(7, 100).Select(n => (long)n), middle.Events.Select(e => e.Sequence));
        Assert.Equal(Enumerable.Range(1, 6).Select(n => (long)n), last.Events.Select(e => e.Sequence));
        Assert.False(last.HasEarlierEvents);
        Assert.Null(last.NextBeforeEventSequence);
        Assert.Equal("Created", last.Events[0].Kind);
        Assert.All(first.Events, e => Assert.Equal(Time, e.OccurredAtUtc));
        var fenced = IncidentWorkflow.Page(incident.Events, 3, null);
        Assert.Equal(new long[] { 1, 2, 3 }, fenced.Events.Select(e => e.Sequence));
        Assert.Empty(IncidentWorkflow.Page(incident.Events, 206, 1).Events);
        Assert.Equal(first.Events.Select(e => e.Sequence), incident.ToResponse(beforeEventSequence: 1000).Events.Select(e => e.Sequence));
    }

    [Theory]
    [InlineData(0)] [InlineData(-1)]
    public void NonpositiveCursorRejected(long cursor) =>
        Assert.Throws<IncidentValidationException>(() => IncidentWorkflow.ValidateCursor(cursor));

    [Theory]
    [InlineData("version_conflict")]
    [InlineData("command_conflict")]
    [InlineData("state_conflict")]
    [InlineData("responder_unchanged")]
    public void ConflictProblemDetailsExposeStableCodeAndObservedState(string code)
    {
        var result = Assert.IsType<ProblemHttpResult>(IncidentEndpoints.Conflict(new(code, "Review current state.", 4, "Monitoring")));
        Assert.Equal(409, result.StatusCode);
        Assert.Equal(code, result.ProblemDetails.Extensions["code"]);
        Assert.Equal(4L, result.ProblemDetails.Extensions["currentVersion"]);
        Assert.Equal("Monitoring", result.ProblemDetails.Extensions["currentStatus"]);
    }

    [Fact]
    public void ModelHasConcurrencyTokenAndDatabaseUniquenessWithoutConnecting()
    {
        using var db = new IncidentDbContext(new DbContextOptionsBuilder<IncidentDbContext>().UseNpgsql("Host=unused;Database=unused").Options);
        var incident = db.Model.FindEntityType(typeof(Incident))!;
        Assert.True(incident.FindProperty(nameof(Incident.Version))!.IsConcurrencyToken);
        var entry = db.Model.FindEntityType(typeof(IncidentEvent))!;
        Assert.Contains(entry.GetIndexes(), i => i.IsUnique && i.Properties.Select(p => p.Name).SequenceEqual(new[] { "IncidentId", "Sequence" }));
        Assert.Contains(entry.GetIndexes(), i => i.IsUnique && i.Properties.Select(p => p.Name).SequenceEqual(new[] { "IncidentId", "CommandId" }) && i.GetFilter() == "\"CommandId\" IS NOT NULL");
        Assert.Contains(entry.GetIndexes(), i => i.IsUnique && i.GetFilter() == "\"Kind\" = 'Created'");
    }

    private static string Serialize(object value) => JsonSerializer.Serialize(value, Json);
    private static IncidentCommand Note(Incident incident, string text) => IncidentWorkflow.Note(new(Guid.NewGuid(), incident.Version, text));
    private static IncidentCommand Transition(Incident incident, string status, string? note = null) => IncidentWorkflow.Transition(new(Guid.NewGuid(), incident.Version, status, note));
    private static IncidentCommand Responder(Incident incident, string? value) => IncidentWorkflow.Responder(new(Guid.NewGuid(), incident.Version, value));
    private static Incident At(string status)
    {
        var incident = New();
        if (status != "Open") incident.Apply(Transition(incident, status, "Initial action"), Time);
        return incident;
    }
    private static Incident New()
    {
        var ap = new OperationsAccessPointObservation("ap-001", "zone-a", true, 84, .95, .078, .017, "inactive", true, "firing", "simulated", Time);
        var overview = new OperationsOverviewResponse(Time, [ap], [], new("probe", true, .01, 200, "measured", Time), new(true, 1, "measured", Time));
        return Incident.Create(new("Issue", [new("ap-001", "degraded")], "Original team"), new(overview, [], Time), Time);
    }
}
