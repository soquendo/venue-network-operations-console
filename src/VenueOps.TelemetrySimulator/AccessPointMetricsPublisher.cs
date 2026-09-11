using Prometheus;

namespace VenueOps.TelemetrySimulator;

public sealed class AccessPointMetricsPublisher(CollectorRegistry registry)
{
    private readonly SemaphoreSlim _exportGuard = new(1, 1);
    private readonly Gauge Operational = Metrics.WithCustomRegistry(registry).CreateGauge(
        "venue_ap_operational",
        "Whether the simulated wireless access point is operational (1) or offline (0).",
        "ap_id",
        "zone");

    private readonly Gauge Clients = Metrics.WithCustomRegistry(registry).CreateGauge(
        "venue_ap_clients",
        "Current simulated associated-client count.",
        "ap_id",
        "zone");

    private readonly Gauge ChannelUtilization = Metrics.WithCustomRegistry(registry).CreateGauge(
        "venue_ap_channel_utilization_ratio",
        "Simulated wireless channel utilization ratio from 0 to 1.",
        "ap_id",
        "zone");

    private readonly Gauge ManagementLatency = Metrics.WithCustomRegistry(registry).CreateGauge(
        "venue_ap_management_latency_seconds",
        "Simulated management-plane round-trip latency in seconds.",
        "ap_id",
        "zone");

    private readonly Gauge ManagementPacketLoss = Metrics.WithCustomRegistry(registry).CreateGauge(
        "venue_ap_management_packet_loss_ratio",
        "Simulated management-plane packet loss ratio from 0 to 1.",
        "ap_id",
        "zone");

    public async Task ExportAsync(
        Func<IReadOnlyList<AccessPointSnapshot>> capture,
        Func<Task> export,
        CancellationToken cancellationToken)
    {
        await _exportGuard.WaitAsync(cancellationToken);
        try
        {
            // Capture after acquiring ownership; retain it through the entire export.
            var snapshot = capture();
            foreach (var accessPoint in snapshot) Publish(accessPoint);
            await export();
        }
        finally { _exportGuard.Release(); }
    }

    private void Publish(AccessPointSnapshot accessPoint)
    {
        var labels = new[] { accessPoint.ApId, accessPoint.Zone };

        Operational.WithLabels(labels).Set(accessPoint.Operational ? 1 : 0);
        Clients.WithLabels(labels).Set(accessPoint.Clients);

        if (!accessPoint.Operational)
        {
            ChannelUtilization.RemoveLabelled(labels);
            ManagementLatency.RemoveLabelled(labels);
            ManagementPacketLoss.RemoveLabelled(labels);
            return;
        }

        ChannelUtilization.WithLabels(labels).Set(accessPoint.ChannelUtilizationRatio!.Value);
        ManagementLatency.WithLabels(labels).Set(accessPoint.ManagementLatencySeconds!.Value);
        ManagementPacketLoss.WithLabels(labels).Set(accessPoint.ManagementPacketLossRatio!.Value);
    }
}
