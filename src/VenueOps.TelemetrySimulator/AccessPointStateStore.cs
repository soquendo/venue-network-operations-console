namespace VenueOps.TelemetrySimulator;

public sealed class AccessPointStateStore
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, AccessPointState> _accessPoints = new(StringComparer.OrdinalIgnoreCase)
    {
        ["ap-001"] = new("ap-001", "zone-a", 42, 0.55, 0.018, 0.002),
        ["ap-002"] = new("ap-002", "zone-a", 35, 0.48, 0.016, 0.001),
        ["ap-003"] = new("ap-003", "zone-b", 28, 0.41, 0.015, 0.001),
        ["ap-004"] = new("ap-004", "zone-b", 31, 0.46, 0.017, 0.002)
    };

    public IReadOnlyList<AccessPointSnapshot> GetAll()
    {
        lock (_lock)
        {
            return _accessPoints.Values
                .OrderBy(accessPoint => accessPoint.ApId, StringComparer.Ordinal)
                .Select(accessPoint => accessPoint.ToSnapshot())
                .ToArray();
        }
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
            snapshot = accessPoint.ToSnapshot();
            return true;
        }
    }

    private sealed class AccessPointState(
        string apId,
        string zone,
        int healthyClients,
        double healthyChannelUtilizationRatio,
        double healthyManagementLatencySeconds,
        double healthyManagementPacketLossRatio)
    {
        public string ApId { get; } = apId;
        public string Zone { get; } = zone;
        public int HealthyClients { get; } = healthyClients;
        public double HealthyChannelUtilizationRatio { get; } = healthyChannelUtilizationRatio;
        public double HealthyManagementLatencySeconds { get; } = healthyManagementLatencySeconds;
        public double HealthyManagementPacketLossRatio { get; } = healthyManagementPacketLossRatio;
        public string Scenario { get; set; } = AccessPointScenario.Healthy;

        public AccessPointSnapshot ToSnapshot()
        {
            var operational = Scenario == AccessPointScenario.Healthy;

            return new AccessPointSnapshot(
                ApId,
                Zone,
                Scenario,
                operational,
                operational ? HealthyClients : 0,
                operational ? HealthyChannelUtilizationRatio : null,
                operational ? HealthyManagementLatencySeconds : null,
                operational ? HealthyManagementPacketLossRatio : null);
        }
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
