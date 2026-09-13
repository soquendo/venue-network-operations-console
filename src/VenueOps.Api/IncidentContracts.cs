using System.Text.Json.Serialization;

namespace VenueOps.Api;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record CreateIncidentRequest(
    string? Title,
    IReadOnlyList<IncidentAccessPointRequest>? AccessPoints,
    string? ResponderLabel = null,
    Guid? CreationCommandId = null)
{
    public void Validate()
    {
        if (CreationCommandId == Guid.Empty)
            throw new IncidentValidationException("Creation command ID must be a non-empty UUID when supplied.");
        if (string.IsNullOrWhiteSpace(Title) || Title.Length > 200)
            throw new IncidentValidationException("Title must contain 1–200 characters.");
        if (ResponderLabel?.Length > 100)
            throw new IncidentValidationException("Responder label must not exceed 100 characters.");
        if (AccessPoints is null || AccessPoints.Count is < 1 or > 4)
            throw new IncidentValidationException("Select between one and four access points.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var ap in AccessPoints)
        {
            if (ap is null || string.IsNullOrWhiteSpace(ap.ApId) || ap.ApId.Length > 64)
                throw new IncidentValidationException("Each selection requires a bounded AP identity.");
            if (!ids.Add(ap.ApId))
                throw new IncidentValidationException("Access point selections must be unique.");
            if (ap.ExpectedCondition is not ("offline" or "degraded"))
                throw new IncidentValidationException("Expected condition must be offline or degraded.");
        }
    }
}

public sealed record IncidentListRequest(string? Status = null, string? Zone = null, long? BeforeId = null)
{
    public const int PageSize = 50;
    public void Validate()
    {
        if (Status is not (null or "Open" or "Investigating" or "Monitoring" or "Resolved"))
            throw new IncidentValidationException("Status must be Open, Investigating, Monitoring, or Resolved.");
        if (Zone is not null && (string.IsNullOrWhiteSpace(Zone) || Zone.Length > 64))
            throw new IncidentValidationException("Zone must contain 1–64 characters when supplied.");
        if (Zone?.Contains('\0') == true)
            throw new IncidentValidationException("Zone must not contain NUL characters.");
        if (BeforeId is <= 0)
            throw new IncidentValidationException("Before ID must be positive.");
    }
}

public sealed record IncidentSummary(long Id, string Title, string Status, string Zone,
    string? ResponderLabel, DateTimeOffset CreatedAtUtc, DateTimeOffset? ResolvedAtUtc,
    long Version, int AffectedAccessPointCount)
{
    public string Number => Incident.FormatNumber(Id);
}

public sealed record IncidentListResponse(IReadOnlyList<IncidentSummary> Items, bool HasMore, long? NextBeforeId)
{
    public static IncidentListResponse Page(IReadOnlyList<IncidentSummary> rows)
    {
        var items = rows.Take(IncidentListRequest.PageSize).ToArray();
        var more = rows.Count > IncidentListRequest.PageSize;
        return new(items, more, more ? items[^1].Id : null);
    }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record IncidentAccessPointRequest(string? ApId, string? ExpectedCondition);

public sealed record IncidentAlertObservation(
    string Name, string State, string Severity, string TelemetrySource,
    string ApId, string Zone, DateTimeOffset ObservedAtUtc);

public sealed record IncidentMonitoringCapture(
    OperationsOverviewResponse Overview,
    IReadOnlyList<IncidentAlertObservation> ActiveAlerts,
    DateTimeOffset CapturedAtUtc);

public sealed record IncidentResponse(
    long Id, string Number, string Title, string Zone, string Status,
    string? ResponderLabel, DateTimeOffset CreatedAtUtc,
    IncidentEvidenceResponse MonitoringEvidence, IReadOnlyList<IncidentEventResponse> Events,
    long Version, DateTimeOffset? ResolvedAtUtc, bool HasEarlierEvents, long? NextBeforeEventSequence);

public sealed record IncidentEvidenceResponse(
    DateTimeOffset CapturedAtUtc, DateTimeOffset GeneratedAtUtc,
    IReadOnlyList<IncidentAccessPointResponse> AccessPoints);

public sealed record IncidentAccessPointResponse(
    string ApId, string Zone, bool Operational, bool Degraded, int Clients,
    double? ChannelUtilizationRatio, double? ManagementLatencySeconds,
    double? ManagementPacketLossRatio, string AlertState, string DegradationAlertState,
    string Source, DateTimeOffset ObservedAtUtc,
    IncidentAlertObservation? DownAlert, IncidentAlertObservation? DegradationAlert);

public sealed record IncidentEventResponse(long Id, string Kind, DateTimeOffset OccurredAtUtc,
    long Sequence, Guid? CommandId, string? Text, string? FromStatus, string? ToStatus,
    string? PreviousResponderLabel, string? ResponderLabel);
public sealed record IncidentCommandReceipt(long IncidentId, Guid CommandId, long Version, IncidentEventResponse Event);
public sealed record IncidentEventPage(IReadOnlyList<IncidentEventResponse> Events, bool HasEarlierEvents, long? NextBeforeEventSequence);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AddIncidentNoteRequest(Guid CommandId, long ExpectedVersion, string? Text);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record TransitionIncidentRequest(Guid CommandId, long ExpectedVersion, string? Status, string? Note = null);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ChangeIncidentResponderRequest(Guid CommandId, long ExpectedVersion,
    [property: JsonRequired] string? ResponderLabel);

public sealed class IncidentWorkflowConflictException(string code, string message, long? currentVersion = null, string? currentStatus = null) : Exception(message)
{
    public string Code { get; } = code;
    public long? CurrentVersion { get; } = currentVersion;
    public string? CurrentStatus { get; } = currentStatus;
}
public sealed class IncidentValidationException(string message) : Exception(message);
public sealed class IncidentConditionChangedException(string message) : Exception(message);
public sealed class IncidentCreationConflictException(string message) : Exception(message);
