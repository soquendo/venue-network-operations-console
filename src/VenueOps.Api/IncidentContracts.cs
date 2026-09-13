using System.Text.Json.Serialization;

namespace VenueOps.Api;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record CreateIncidentRequest(
    string? Title,
    IReadOnlyList<IncidentAccessPointRequest>? AccessPoints,
    string? ResponderLabel = null)
{
    public void Validate()
    {
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
    IncidentEvidenceResponse MonitoringEvidence, IReadOnlyList<IncidentEventResponse> Events);

public sealed record IncidentEvidenceResponse(
    DateTimeOffset CapturedAtUtc, DateTimeOffset GeneratedAtUtc,
    IReadOnlyList<IncidentAccessPointResponse> AccessPoints);

public sealed record IncidentAccessPointResponse(
    string ApId, string Zone, bool Operational, bool Degraded, int Clients,
    double? ChannelUtilizationRatio, double? ManagementLatencySeconds,
    double? ManagementPacketLossRatio, string AlertState, string DegradationAlertState,
    string Source, DateTimeOffset ObservedAtUtc,
    IncidentAlertObservation? DownAlert, IncidentAlertObservation? DegradationAlert);

public sealed record IncidentEventResponse(long Id, string Kind, DateTimeOffset OccurredAtUtc);
public sealed class IncidentValidationException(string message) : Exception(message);
public sealed class IncidentConditionChangedException(string message) : Exception(message);
