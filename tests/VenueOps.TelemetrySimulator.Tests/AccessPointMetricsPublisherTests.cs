using System.Text;
using Prometheus;
using VenueOps.TelemetrySimulator;
using Xunit;

namespace VenueOps.TelemetrySimulator.Tests;

public sealed class AccessPointMetricsPublisherTests
{
    [Fact]
    public async Task ExportsOnlyExistingVenueFamiliesAndRestoresRemovedOfflineSeries()
    {
        var store = new AccessPointStateStore();
        var registry = Metrics.NewCustomRegistry();
        var publisher = new AccessPointMetricsPublisher(registry);
        store.SetEventPosition(360);
        var peak = await Export(publisher, registry, store);
        Assert.Contains("venue_ap_clients{ap_id=\"ap-001\",zone=\"zone-a\"} 84", peak);
        Assert.Contains("venue_ap_management_latency_seconds{ap_id=\"ap-001\",zone=\"zone-a\"} 0.078", peak);
        Assert.Equal(5, peak.Split('\n').Count(line => line.StartsWith("# TYPE venue_ap_")));
        Assert.Equal(20, peak.Split('\n').Count(line => line.StartsWith("venue_ap_")));
        store.TrySetScenario("ap-001", AccessPointScenario.Offline, out _);
        var offline = await Export(publisher, registry, store);
        Assert.Contains("venue_ap_operational{ap_id=\"ap-001\",zone=\"zone-a\"} 0", offline);
        Assert.Contains("venue_ap_clients{ap_id=\"ap-001\",zone=\"zone-a\"} 0", offline);
        Assert.DoesNotContain("venue_ap_channel_utilization_ratio{ap_id=\"ap-001\"", offline);
        Assert.DoesNotContain("venue_ap_management_latency_seconds{ap_id=\"ap-001\"", offline);
        Assert.DoesNotContain("venue_ap_management_packet_loss_ratio{ap_id=\"ap-001\"", offline);
        store.TrySetScenario("ap-001", AccessPointScenario.Healthy, out _);
        var rejoined = await Export(publisher, registry, store);
        Assert.Equal(peak.Split('\n').Order(StringComparer.Ordinal), rejoined.Split('\n').Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task SerializesTheWholeExportAndCapturesQueuedSnapshotsOnlyAfterAcquiringOwnership()
    {
        var store = new AccessPointStateStore();
        var registry = Metrics.NewCustomRegistry();
        var publisher = new AccessPointMetricsPublisher(registry);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var captures = 0;
        store.SetEventPosition(360);
        using var firstBody = new MemoryStream();
        var first = publisher.ExportAsync(() => { captures++; return store.GetAll(); }, async () =>
        {
            entered.SetResult();
            await release.Task;
            await registry.CollectAndExportAsTextAsync(firstBody);
        }, CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        store.SetEventPosition(240);
        using var secondBody = new MemoryStream();
        var second = publisher.ExportAsync(() => { captures++; return store.GetAll(); },
            () => registry.CollectAndExportAsTextAsync(secondBody), CancellationToken.None);
        try
        {
            Assert.False(second.IsCompleted);
            Assert.Equal(1, captures);
            store.ResetEventDay();
        }
        finally { release.TrySetResult(); }
        await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, captures);
        var original = Encoding.UTF8.GetString(firstBody.ToArray());
        var latest = Encoding.UTF8.GetString(secondBody.ToArray());
        Assert.Contains("venue_ap_clients{ap_id=\"ap-001\",zone=\"zone-a\"} 84", original);
        Assert.Contains("venue_ap_channel_utilization_ratio{ap_id=\"ap-001\",zone=\"zone-a\"} 0.95", original);
        Assert.Contains("venue_ap_clients{ap_id=\"ap-001\",zone=\"zone-a\"} 42", latest);
        Assert.Contains("venue_ap_channel_utilization_ratio{ap_id=\"ap-001\",zone=\"zone-a\"} 0.55", latest);
    }

    [Theory]
    [InlineData("capture")]
    [InlineData("export")]
    [InlineData("cancel-export")]
    public async Task FailedOrCancelledExportsReleaseOwnership(string failure)
    {
        var store = new AccessPointStateStore();
        var registry = Metrics.NewCustomRegistry();
        var publisher = new AccessPointMetricsPublisher(registry);
        Task Attempt() => publisher.ExportAsync(
            () => failure == "capture" ? throw new InvalidOperationException("capture") : store.GetAll(),
            () => failure == "cancel-export" ? Task.FromCanceled(new CancellationToken(true)) : throw new InvalidOperationException("export"),
            CancellationToken.None);
        if (failure == "cancel-export") await Assert.ThrowsAnyAsync<OperationCanceledException>(Attempt);
        else await Assert.ThrowsAsync<InvalidOperationException>(Attempt);
        Assert.Contains("venue_ap_clients", await Export(publisher, registry, store).WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task CancellationWhileWaitingDoesNotCaptureOrReleaseAnotherExportsGuard()
    {
        var registry = Metrics.NewCustomRegistry();
        var publisher = new AccessPointMetricsPublisher(registry);
        var store = new AccessPointStateStore();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = publisher.ExportAsync(store.GetAll, () => release.Task, CancellationToken.None);
        using var cancellation = new CancellationTokenSource();
        var captured = false;
        var waiting = publisher.ExportAsync(() => { captured = true; return store.GetAll(); }, () => Task.CompletedTask, cancellation.Token);
        try
        {
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting);
            Assert.False(captured);
            var next = publisher.ExportAsync(store.GetAll, () => Task.CompletedTask, CancellationToken.None);
            Assert.False(next.IsCompleted);
            release.SetResult();
            await next.WaitAsync(TimeSpan.FromSeconds(5));
        }
        finally { release.TrySetResult(); await first; }
    }

    private static async Task<string> Export(AccessPointMetricsPublisher publisher, CollectorRegistry registry, AccessPointStateStore store)
    {
        using var body = new MemoryStream();
        await publisher.ExportAsync(store.GetAll, () => registry.CollectAndExportAsTextAsync(body), CancellationToken.None);
        return Encoding.UTF8.GetString(body.ToArray());
    }
}
