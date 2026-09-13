using System.Globalization;

namespace VenueOps.Api;

public sealed class Incident
{
    private readonly List<IncidentAccessPointContext> _accessPoints = [];
    private readonly List<IncidentEvent> _events = [];
    private Incident() { }
    public long Id { get; private set; }
    public Guid? CreationCommandId { get; private set; }
    public string Title { get; private set; } = "";
    public string Zone { get; private set; } = "";
    public string Status { get; private set; } = "Open";
    public string? ResponderLabel { get; private set; }
    public long Version { get; private set; } = 1;
    public DateTimeOffset? ResolvedAtUtc { get; private set; }
    public DateTimeOffset CreatedAtUtc { get; private set; }
    public DateTimeOffset MonitoringCaptureAtUtc { get; private set; }
    public DateTimeOffset OverviewGeneratedAtUtc { get; private set; }
    public IReadOnlyList<IncidentAccessPointContext> AccessPoints => _accessPoints.AsReadOnly();
    public IReadOnlyList<IncidentEvent> Events => _events.AsReadOnly();

    public static Incident Create(CreateIncidentRequest request, IncidentMonitoringCapture capture, DateTimeOffset createdAtUtc)
    {
        request.Validate();
        createdAtUtc = AtDatabasePrecision(createdAtUtc);
        if (!capture.Overview.SimulatorScrape.Up)
            throw new PrometheusQueryException("Current simulator telemetry is unavailable; retained lookback values cannot establish a current condition.");
        var selected = request.AccessPoints!.Select(selection =>
        {
            var ap = capture.Overview.AccessPoints.SingleOrDefault(ap => ap.ApId == selection.ApId)
                ?? throw new IncidentValidationException($"Unknown access point: {selection.ApId}.");
            return (Selection: selection, Ap: ap);
        }).ToArray();
        if (selected.Select(item => item.Ap.Zone).Distinct(StringComparer.Ordinal).Count() != 1)
            throw new IncidentValidationException("Selected access points must belong to one zone.");
        foreach (var (selection, ap) in selected)
        {
            var matches = selection.ExpectedCondition == "offline" ? !ap.Operational : ap.Operational && ap.Degraded;
            if (!matches)
                throw new IncidentConditionChangedException($"The current condition for {ap.ApId} no longer matches {selection.ExpectedCondition}. Review current monitoring before creating the incident.");
        }
        var incident = new Incident
        {
            CreationCommandId = request.CreationCommandId,
            Title = request.Title!.Trim(), Zone = selected[0].Ap.Zone,
            ResponderLabel = string.IsNullOrWhiteSpace(request.ResponderLabel) ? null : request.ResponderLabel.Trim(),
            CreatedAtUtc = createdAtUtc, MonitoringCaptureAtUtc = AtDatabasePrecision(capture.CapturedAtUtc),
            OverviewGeneratedAtUtc = AtDatabasePrecision(capture.Overview.GeneratedAtUtc)
        };
        foreach (var (_, ap) in selected.OrderBy(item => item.Ap.ApId, StringComparer.Ordinal))
            incident._accessPoints.Add(new IncidentAccessPointContext(ap, capture.ActiveAlerts));
        incident._events.Add(new IncidentEvent(createdAtUtc, incident.ResponderLabel));
        return incident;
    }

    public bool MatchesCreationIntent(CreateIncidentRequest request, IncidentEvent created)
    {
        request.Validate();
        // Current responder/status can change. Only immutable creation evidence
        // and the original Created event define the intent of a creation retry.
        if (created.Kind != "Created" || created.Sequence != 1
            || Title != request.Title!.Trim()
            || created.ResponderLabel != (string.IsNullOrWhiteSpace(request.ResponderLabel) ? null : request.ResponderLabel.Trim()))
            return false;
        var expected = request.AccessPoints!.OrderBy(ap => ap.ApId, StringComparer.Ordinal)
            .Select(ap => (ap.ApId, ap.ExpectedCondition));
        var captured = _accessPoints.OrderBy(ap => ap.ApId, StringComparer.Ordinal)
            .Select(ap => ((string?)ap.ApId, !ap.Operational ? "offline" : ap.Degraded ? "degraded" : null));
        return expected.SequenceEqual(captured);
    }

    // PostgreSQL timestamps have microsecond precision. Normalize before returning the
    // created representation so its timestamps exactly match subsequent stored reads.
    internal static DateTimeOffset AtDatabasePrecision(DateTimeOffset value) => new(value.UtcTicks - value.UtcTicks % 10, TimeSpan.Zero);

    public static string FormatNumber(long id) => "INC-" + id.ToString("D6", CultureInfo.InvariantCulture);
    public IncidentEvent Apply(IncidentCommand command, DateTimeOffset occurredAtUtc)
    {
        IncidentWorkflow.ValidateState(this, command);
        var timestamp = AtDatabasePrecision(occurredAtUtc);
        var sequence = checked(Version + 1);
        var entry = new IncidentEvent(Id, sequence, command, timestamp, Status, ResponderLabel);
        if (command.Kind == "StatusChanged")
        {
            Status = command.Status!;
            ResolvedAtUtc = Status == "Resolved" ? timestamp : null;
        }
        if (command.Kind == "ResponderChanged") ResponderLabel = command.ResponderLabel;
        Version = sequence;
        _events.Add(entry);
        return entry;
    }

    public IncidentResponse ToResponse(IEnumerable<IncidentEvent>? events = null, long? beforeEventSequence = null)
    {
        var page = IncidentWorkflow.Page(events ?? _events, Version, beforeEventSequence);
        return new(Id, FormatNumber(Id), Title, Zone, Status, ResponderLabel, CreatedAtUtc,
            new(MonitoringCaptureAtUtc, OverviewGeneratedAtUtc, _accessPoints.OrderBy(ap => ap.ApId, StringComparer.Ordinal).Select(ap => ap.ToResponse()).ToArray()),
            page.Events, Version, ResolvedAtUtc, page.HasEarlierEvents, page.NextBeforeEventSequence);
    }
}

public sealed class IncidentAccessPointContext
{
    private IncidentAccessPointContext() { }
    internal IncidentAccessPointContext(OperationsAccessPointObservation ap, IReadOnlyList<IncidentAlertObservation> alerts)
    {
        ApId = ap.ApId; Zone = ap.Zone; Operational = ap.Operational; Degraded = ap.Degraded;
        Clients = ap.Clients; ChannelUtilizationRatio = ap.ChannelUtilizationRatio;
        ManagementLatencySeconds = ap.ManagementLatencySeconds; ManagementPacketLossRatio = ap.ManagementPacketLossRatio;
        AlertState = ap.AlertState; DegradationAlertState = ap.DegradationAlertState;
        Source = ap.Source; ObservedAtUtc = Incident.AtDatabasePrecision(ap.ObservedAtUtc);
        DownAlert = alerts.SingleOrDefault(a => a.ApId == ApId && a.Zone == Zone && a.Name == "VenueApDown");
        if (DownAlert is not null) DownAlert = DownAlert with { ObservedAtUtc = Incident.AtDatabasePrecision(DownAlert.ObservedAtUtc) };
        DegradationAlert = alerts.SingleOrDefault(a => a.ApId == ApId && a.Zone == Zone && a.Name == "VenueApDegraded");
        if (DegradationAlert is not null) DegradationAlert = DegradationAlert with { ObservedAtUtc = Incident.AtDatabasePrecision(DegradationAlert.ObservedAtUtc) };
    }
    public long IncidentId { get; private set; }
    public string ApId { get; private set; } = "";
    public string Zone { get; private set; } = "";
    public bool Operational { get; private set; }
    public bool Degraded { get; private set; }
    public int Clients { get; private set; }
    public double? ChannelUtilizationRatio { get; private set; }
    public double? ManagementLatencySeconds { get; private set; }
    public double? ManagementPacketLossRatio { get; private set; }
    public string AlertState { get; private set; } = "";
    public string DegradationAlertState { get; private set; } = "";
    public string Source { get; private set; } = "";
    public DateTimeOffset ObservedAtUtc { get; private set; }
    public IncidentAlertObservation? DownAlert { get; private set; }
    public IncidentAlertObservation? DegradationAlert { get; private set; }
    internal IncidentAccessPointResponse ToResponse() => new(ApId, Zone, Operational, Degraded, Clients,
        ChannelUtilizationRatio, ManagementLatencySeconds, ManagementPacketLossRatio, AlertState,
        DegradationAlertState, Source, ObservedAtUtc, DownAlert, DegradationAlert);
}
