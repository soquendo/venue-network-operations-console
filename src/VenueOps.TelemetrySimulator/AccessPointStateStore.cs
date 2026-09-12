namespace VenueOps.TelemetrySimulator;

public sealed class AccessPointStateStore
{
    private readonly Lock _lock = new();
    private readonly TimeProvider _timeProvider;
    private EventDayPosition? _heldPosition;
    private long? _runStartedTimestamp;
    private readonly Dictionary<string, AccessPointState> _accessPoints = new(StringComparer.OrdinalIgnoreCase)
    {
        ["ap-001"] = new(new("ap-001", "zone-a", 42, 0.55m, 0.018m, 0.002m)),
        ["ap-002"] = new(new("ap-002", "zone-a", 35, 0.48m, 0.016m, 0.001m)),
        ["ap-003"] = new(new("ap-003", "zone-b", 28, 0.41m, 0.015m, 0.001m)),
        ["ap-004"] = new(new("ap-004", "zone-b", 31, 0.46m, 0.017m, 0.002m))
    };

    public AccessPointStateStore() : this(TimeProvider.System) { }

    public AccessPointStateStore(TimeProvider timeProvider) => _timeProvider = timeProvider;

    public IReadOnlyList<AccessPointSnapshot> GetAll()
    {
        lock (_lock)
        {
            return SnapshotAccessPoints(ResolvePosition().Position);
        }
    }

    public EventDaySnapshot GetEventDay()
    {
        lock (_lock) return SnapshotEventDay();
    }

    public EventDaySnapshot StartEventDay()
    {
        lock (_lock)
        {
            _runStartedTimestamp = _timeProvider.GetTimestamp();
            _heldPosition = null;
            foreach (var accessPoint in _accessPoints.Values) accessPoint.Scenario = AccessPointScenario.Healthy;
            // The command response uses the anchor itself, even if execution is delayed.
            return SnapshotEventDay(_runStartedTimestamp);
        }
    }

    public EventDaySnapshot SetEventPosition(int elapsedMinutes)
    {
        var position = EventDayScenario.Evaluate(elapsedMinutes);
        lock (_lock)
        {
            _runStartedTimestamp = null;
            _heldPosition = position;
            return SnapshotEventDay();
        }
    }

    public EventDaySnapshot ResetEventDay()
    {
        lock (_lock)
        {
            _runStartedTimestamp = null;
            _heldPosition = null;
            foreach (var accessPoint in _accessPoints.Values) accessPoint.Scenario = AccessPointScenario.Healthy;
            return SnapshotEventDay();
        }
    }

    // Called only while holding the state lock; returned records are detached from mutable state.
    private IReadOnlyList<AccessPointSnapshot> SnapshotAccessPoints(EventDayPosition? position) => Array.AsReadOnly(_accessPoints.Values
        .OrderBy(accessPoint => accessPoint.Baseline.ApId, StringComparer.Ordinal)
        .Select(accessPoint => accessPoint.ToSnapshot(position?.NormalizedLoad ?? 0m))
        .ToArray());

    private EventDaySnapshot SnapshotEventDay(long? capturedTimestamp = null)
    {
        var (mode, position) = ResolvePosition(capturedTimestamp);
        return new(EventDayScenario.Name, mode, position?.ElapsedMinutes, position?.Phase,
            position?.NormalizedLoad ?? 0m, SnapshotAccessPoints(position));
    }

    // Called under the state lock. Completion is derived, so reads never mutate the run.
    private (string Mode, EventDayPosition? Position) ResolvePosition(long? capturedTimestamp = null)
    {
        if (_runStartedTimestamp is long started)
        {
            var now = capturedTimestamp ?? _timeProvider.GetTimestamp();
            var elapsed = _timeProvider.GetElapsedTime(started, now);
            var minute = (int)Math.Clamp(elapsed.Ticks / TimeSpan.TicksPerSecond, 0L, 660L);
            return (minute == 660 ? "completed" : "running", EventDayScenario.Evaluate(minute));
        }
        return (_heldPosition is null ? "baseline" : "held", _heldPosition);
    }

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
            snapshot = accessPoint.ToSnapshot(ResolvePosition().Position?.NormalizedLoad ?? 0m);
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
