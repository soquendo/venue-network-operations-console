namespace VenueOps.TelemetrySimulator;

public static class EventDayScenario
{
    public const string Name = "High-Density Event Day";

    private static readonly EventDayPosition[] Knots =
    [
        new(0, "PRE_OPEN", 0m),
        new(150, "ARRIVAL", 0.25m),
        new(240, "BUILDING_LOAD", 0.50m),
        new(360, "PEAK_DENSITY", 1m),
        new(480, "RECOVERY", 1m),
        new(660, "EVENT_CLOSE", 0m)
    ];

    public static EventDayPosition Evaluate(int elapsedMinutes)
    {
        if (elapsedMinutes is < 0 or > 660)
        {
            throw new ArgumentOutOfRangeException(nameof(elapsedMinutes), "Use an integer virtual minute from 0 through 660.");
        }

        for (var index = Knots.Length - 1; index >= 0; index--)
        {
            var current = Knots[index];
            if (elapsedMinutes < current.ElapsedMinutes) continue;
            if (index == Knots.Length - 1) return current;
            var next = Knots[index + 1];
            var progress = (decimal)(elapsedMinutes - current.ElapsedMinutes)
                / (next.ElapsedMinutes - current.ElapsedMinutes);
            return new EventDayPosition(elapsedMinutes, current.Phase,
                current.NormalizedLoad + progress * (next.NormalizedLoad - current.NormalizedLoad));
        }

        throw new InvalidOperationException("The event profile has no baseline position.");
    }

    public static AccessPointSnapshot Measure(AccessPointBaseline baseline, bool operational, decimal normalizedLoad)
    {
        if (!operational)
        {
            return new(baseline.ApId, baseline.Zone, AccessPointScenario.Offline, false, 0, null, null, null);
        }

        // Synthetic calibration: compute every observation from the immutable baseline.
        var pressure = baseline.Zone == "zone-a" ? normalizedLoad : normalizedLoad / 2m;
        var clients = decimal.ToInt32(decimal.Round(baseline.Clients * (1m + pressure), 0, MidpointRounding.AwayFromZero));
        var utilization = baseline.ChannelUtilizationRatio + 0.40m * pressure;
        var latency = baseline.ManagementLatencySeconds + 0.20m * Math.Max(0m, utilization - 0.65m);
        var loss = baseline.ManagementPacketLossRatio + 0.10m * Math.Max(0m, utilization - 0.80m);
        return new(baseline.ApId, baseline.Zone, AccessPointScenario.Healthy, true,
            clients, (double)utilization, (double)latency, (double)loss);
    }
}

public sealed record EventDayPosition(int ElapsedMinutes, string Phase, decimal NormalizedLoad);

public sealed record AccessPointBaseline(
    string ApId, string Zone, int Clients, decimal ChannelUtilizationRatio,
    decimal ManagementLatencySeconds, decimal ManagementPacketLossRatio);

public sealed record EventDaySnapshot(
    string Scenario, string Mode, int? ElapsedMinutes, string? Phase,
    decimal NormalizedLoad, IReadOnlyList<AccessPointSnapshot> AccessPoints);
