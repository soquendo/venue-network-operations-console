namespace VenueOps.Api;

public static class AccessPointDegradation
{
    // Synthetic congestion policy; mirror its boundaries in the Prometheus rule tests.
    // Call only after validating required telemetry. Offline measurements are unavailable.
    public static bool IsDegraded(bool operational, double? utilization, double? latency, double? loss) =>
        operational && utilization >= 0.80 && (latency >= 0.050 || loss >= 0.010);
}
