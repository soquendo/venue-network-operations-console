namespace VenueOps.TelemetrySimulator;

public sealed class AccessPointStateStore
{
    private readonly Lock _lock = new();
    private EventDayPosition? _heldPosition;
    private readonly Dictionary<string, AccessPointState> _accessPoints = new(StringComparer.OrdinalIgnoreCase)
    {
        ["ap-001"] = new(new("ap-001", "zone-a", 42, 0.55m, 0.018m, 0.002m)),
        ["ap-002"] = new(new("ap-002", "zone-a", 35, 0.48m, 0.016m, 0.001m)),
        ["ap-003"] = new(new("ap-003", "zone-b", 28, 0.41m, 0.015m, 0.001m)),
        ["ap-004"] = new(new("ap-004", "zone-b", 31, 0.46m, 0.017m, 0.002m))
    };

    public IReadOnlyList<AccessPointSnapshot> GetAll()
    {
        lock (_lock)
        {
            return SnapshotAccessPoints();
        }
    }

    public EventDaySnapshot GetEventDay()
    {
        lock (_lock) return SnapshotEventDay();
    }

    public EventDaySnapshot SetEventPosition(int elapsedMinutes)
    {
        var position = EventDayScenario.Evaluate(elapsedMinutes);
        lock (_lock)
        {
            _heldPosition = position;
            return SnapshotEventDay();
        }
    }

    public EventDaySnapshot ResetEventDay()
    {
        lock (_lock)
        {
            _heldPosition = null;
            foreach (var accessPoint in _accessPoints.Values) accessPoint.Scenario = AccessPointScenario.Healthy;
            return SnapshotEventDay();
        }
    }

    // Called only while holding the state lock; returned records are detached from mutable state.
    private IReadOnlyList<AccessPointSnapshot> SnapshotAccessPoints() => Array.AsReadOnly(_accessPoints.Values
        .OrderBy(accessPoint => accessPoint.Baseline.ApId, StringComparer.Ordinal)
        .Select(accessPoint => accessPoint.ToSnapshot(_heldPosition?.NormalizedLoad ?? 0m))
        .ToArray());

    private EventDaySnapshot SnapshotEventDay() => new(
        EventDayScenario.Name, _heldPosition is null ? "baseline" : "held",
        _heldPosition?.ElapsedMinutes, _heldPosition?.Phase,
        _heldPosition?.NormalizedLoad ?? 0m, SnapshotAccessPoints());

    public bool TrySetScenario(
        string apId,
        string scenario,
        out AccessPointSnapshot snapshot)
    {
        lock (_lock)
        {
            if (!_accessPoints.TryGetValue(apId, out var accessPoint))
            {
                snapshot = default!;
                return false;
            }

            accessPoint.Scenario = scenario;
            snapshot = accessPoint.ToSnapshot(_heldPosition?.NormalizedLoad ?? 0m);
            return true;
        }
    }

    private sealed class AccessPointState(AccessPointBaseline baseline)
    {
        public AccessPointBaseline Baseline { get; } = baseline;
        public string Scenario { get; set; } = AccessPointScenario.Healthy;

        public AccessPointSnapshot ToSnapshot(decimal load) =>
            EventDayScenario.Measure(Baseline, Scenario == AccessPointScenario.Healthy, load);
    }
}

public sealed record AccessPointSnapshot(
    string ApId,
    string Zone,
    string Scenario,
    bool Operational,
    int Clients,
    double? ChannelUtilizationRatio,
    double? ManagementLatencySeconds,
    double? ManagementPacketLossRatio);

public static class AccessPointScenario
{
    public const string Healthy = "healthy";
    public const string Offline = "offline";

    public static bool TryParse(string? value, out string scenario)
    {
        if (string.Equals(value, Healthy, StringComparison.OrdinalIgnoreCase))
        {
            scenario = Healthy;
            return true;
        }

        if (string.Equals(value, Offline, StringComparison.OrdinalIgnoreCase))
        {
            scenario = Offline;
            return true;
        }

        scenario = string.Empty;
        return false;
    }
}
