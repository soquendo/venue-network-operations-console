using VenueOps.TelemetrySimulator;
using Xunit;

namespace VenueOps.TelemetrySimulator.Tests;

public sealed class AccessPointStateStoreTests
{
    [Fact]
    public void HealthyRestoreUsesExactBaselineAndSnapshotsAreDetached()
    {
        var store = new AccessPointStateStore();
        var original = store.GetAll().ToArray();
        store.TrySetScenario("AP-001", AccessPointScenario.Offline, out _);
        Assert.True(original[0].Operational);
        store.TrySetScenario("ap-001", AccessPointScenario.Healthy, out _);
        Assert.Equal(original, store.GetAll());
        Assert.Equal(new[] { 0.55, 0.48, 0.41, 0.46 }, store.GetAll().Select(ap => ap.ChannelUtilizationRatio!.Value));
        Assert.Equal(new[] { 0.018, 0.016, 0.015, 0.017 }, store.GetAll().Select(ap => ap.ManagementLatencySeconds!.Value));
        Assert.Equal(new[] { 0.002, 0.001, 0.001, 0.002 }, store.GetAll().Select(ap => ap.ManagementPacketLossRatio!.Value));
    }

    [Fact]
    public void InitialStateContainsFourHealthyAccessPointsAcrossTwoZones()
    {
        var store = new AccessPointStateStore();

        var accessPoints = store.GetAll();

        Assert.Equal(4, accessPoints.Count);
        Assert.Equal(2, accessPoints.Select(accessPoint => accessPoint.Zone).Distinct().Count());
        Assert.All(accessPoints, accessPoint => Assert.True(accessPoint.Operational));
        Assert.Equal(77, accessPoints.Where(accessPoint => accessPoint.Zone == "zone-a").Sum(accessPoint => accessPoint.Clients));
        Assert.Equal(59, accessPoints.Where(accessPoint => accessPoint.Zone == "zone-b").Sum(accessPoint => accessPoint.Clients));
    }

    [Fact]
    public void OfflineScenarioClearsUnobservableTelemetryAndIsIdempotent()
    {
        var store = new AccessPointStateStore();

        Assert.True(store.TrySetScenario("ap-001", AccessPointScenario.Offline, out var first));
        Assert.True(store.TrySetScenario("ap-001", AccessPointScenario.Offline, out var second));

        Assert.False(first.Operational);
        Assert.Equal(0, first.Clients);
        Assert.Null(first.ChannelUtilizationRatio);
        Assert.Null(first.ManagementLatencySeconds);
        Assert.Null(first.ManagementPacketLossRatio);
        Assert.Equal(first, second);
    }

    [Fact]
    public void UnknownAccessPointIsRejected()
    {
        var store = new AccessPointStateStore();

        var found = store.TrySetScenario("ap-999", AccessPointScenario.Offline, out _);

        Assert.False(found);
    }
}
