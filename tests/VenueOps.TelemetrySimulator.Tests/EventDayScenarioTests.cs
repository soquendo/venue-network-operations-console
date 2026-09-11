using VenueOps.TelemetrySimulator;
using Xunit;

namespace VenueOps.TelemetrySimulator.Tests;

public sealed class EventDayScenarioTests
{
    [Theory]
    [InlineData(0, new[] { 42, 35, 28, 31 }, new[] { 0.55, 0.48, 0.41, 0.46 }, new[] { 0.018, 0.016, 0.015, 0.017 }, new[] { 0.002, 0.001, 0.001, 0.002 }, 77, 59)]
    [InlineData(150, new[] { 53, 44, 32, 35 }, new[] { 0.65, 0.58, 0.46, 0.51 }, new[] { 0.018, 0.016, 0.015, 0.017 }, new[] { 0.002, 0.001, 0.001, 0.002 }, 97, 67)]
    [InlineData(240, new[] { 63, 53, 35, 39 }, new[] { 0.75, 0.68, 0.51, 0.56 }, new[] { 0.038, 0.022, 0.015, 0.017 }, new[] { 0.002, 0.001, 0.001, 0.002 }, 116, 74)]
    [InlineData(360, new[] { 84, 70, 42, 47 }, new[] { 0.95, 0.88, 0.61, 0.66 }, new[] { 0.078, 0.062, 0.015, 0.019 }, new[] { 0.017, 0.009, 0.001, 0.002 }, 154, 89)]
    [InlineData(570, new[] { 63, 53, 35, 39 }, new[] { 0.75, 0.68, 0.51, 0.56 }, new[] { 0.038, 0.022, 0.015, 0.017 }, new[] { 0.002, 0.001, 0.001, 0.002 }, 116, 74)]
    [InlineData(660, new[] { 42, 35, 28, 31 }, new[] { 0.55, 0.48, 0.41, 0.46 }, new[] { 0.018, 0.016, 0.015, 0.017 }, new[] { 0.002, 0.001, 0.001, 0.002 }, 77, 59)]
    public void HeldPositionsHaveExactReferenceMeasurements(int minute, int[] clients, double[] utilization, double[] latency, double[] loss, int zoneA, int zoneB)
    {
        var state = new AccessPointStateStore().SetEventPosition(minute);
        Assert.Equal("held", state.Mode);
        Assert.Equal(minute, state.ElapsedMinutes);
        Assert.Equal("High-Density Event Day", state.Scenario);
        Assert.All(state.AccessPoints, ap => Assert.True(ap.Operational));
        Assert.Equal(clients, state.AccessPoints.Select(ap => ap.Clients));
        Assert.Equal(utilization, state.AccessPoints.Select(ap => ap.ChannelUtilizationRatio!.Value));
        Assert.Equal(latency, state.AccessPoints.Select(ap => ap.ManagementLatencySeconds!.Value));
        Assert.Equal(loss, state.AccessPoints.Select(ap => ap.ManagementPacketLossRatio!.Value));
        Assert.Equal(zoneA, state.AccessPoints.Where(ap => ap.Zone == "zone-a").Sum(ap => ap.Clients));
        Assert.Equal(zoneB, state.AccessPoints.Where(ap => ap.Zone == "zone-b").Sum(ap => ap.Clients));
    }

    [Theory]
    [InlineData(0, "PRE_OPEN", "0")]
    [InlineData(149, "PRE_OPEN", null)]
    [InlineData(150, "ARRIVAL", "0.25")]
    [InlineData(239, "ARRIVAL", null)]
    [InlineData(240, "BUILDING_LOAD", "0.5")]
    [InlineData(359, "BUILDING_LOAD", null)]
    [InlineData(360, "PEAK_DENSITY", "1")]
    [InlineData(479, "PEAK_DENSITY", "1")]
    [InlineData(480, "RECOVERY", "1")]
    [InlineData(570, "RECOVERY", "0.5")]
    [InlineData(659, "RECOVERY", null)]
    [InlineData(660, "EVENT_CLOSE", "0")]
    public void PureEvaluatorOwnsExactPhaseBoundaries(int minute, string phase, string? load)
    {
        var position = EventDayScenario.Evaluate(minute);
        Assert.Equal(phase, position.Phase);
        Assert.Equal(minute, position.ElapsedMinutes);
        if (load is not null) Assert.Equal(decimal.Parse(load, System.Globalization.CultureInfo.InvariantCulture), position.NormalizedLoad);
        Assert.InRange(position.NormalizedLoad, 0m, 1m);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(661)]
    [InlineData(int.MinValue)]
    [InlineData(int.MaxValue)]
    public void InvalidPositionCannotMutateHeldState(int minute)
    {
        var store = new AccessPointStateStore();
        var held = store.SetEventPosition(360);
        Assert.Throws<ArgumentOutOfRangeException>(() => store.SetEventPosition(minute));
        Assert.Equal(held.ElapsedMinutes, store.GetEventDay().ElapsedMinutes);
        Assert.Equal(held.AccessPoints, store.GetAll());
        Assert.Throws<ArgumentOutOfRangeException>(() => EventDayScenario.Evaluate(minute));
    }

    [Fact]
    public void BaselineIsDistinctFromHeldZeroAndResetIsIdempotent()
    {
        var store = new AccessPointStateStore();
        var baseline = store.GetEventDay();
        Assert.Equal("baseline", baseline.Mode);
        Assert.Null(baseline.ElapsedMinutes);
        Assert.Null(baseline.Phase);
        Assert.Equal(0m, baseline.NormalizedLoad);
        var held = store.SetEventPosition(0);
        Assert.Equal("held", held.Mode);
        Assert.Equal(baseline.AccessPoints, held.AccessPoints);
        store.ResetEventDay();
        var reset = store.ResetEventDay();
        Assert.Equal(baseline.Mode, reset.Mode);
        Assert.Null(reset.ElapsedMinutes);
        Assert.Equal(baseline.AccessPoints, reset.AccessPoints);
    }

    [Fact]
    public void RepeatedPositionsAndRunsNeverAccumulateMeasurements()
    {
        var store = new AccessPointStateStore();
        var peak = store.SetEventPosition(360);
        Assert.Equal(peak.AccessPoints, store.SetEventPosition(360).AccessPoints);
        store.SetEventPosition(570);
        store.SetEventPosition(150);
        Assert.Equal(peak.AccessPoints, store.SetEventPosition(360).AccessPoints);
        store.ResetEventDay();
        Assert.Equal(peak.AccessPoints, store.SetEventPosition(360).AccessPoints);
        Assert.Equal(360, store.GetEventDay().ElapsedMinutes);
        Assert.Equal(peak.AccessPoints, store.GetAll());
    }

    [Fact]
    public void OfflineOverridePersistsAcrossPositionsAndHealthyRejoinsCurrentLoad()
    {
        var store = new AccessPointStateStore();
        store.TrySetScenario("ap-001", AccessPointScenario.Offline, out _);
        store.SetEventPosition(240);
        var peak = store.SetEventPosition(360);
        var offline = peak.AccessPoints[0];
        Assert.False(offline.Operational);
        Assert.Equal(0, offline.Clients);
        Assert.Null(offline.ChannelUtilizationRatio);
        Assert.Null(offline.ManagementLatencySeconds);
        Assert.Null(offline.ManagementPacketLossRatio);
        Assert.True(store.TrySetScenario("ap-001", AccessPointScenario.Healthy, out var rejoined));
        Assert.Equal(84, rejoined.Clients);
        Assert.Equal(0.95, rejoined.ChannelUtilizationRatio);
        Assert.Equal(0.078, rejoined.ManagementLatencySeconds);
        Assert.Equal(0.017, rejoined.ManagementPacketLossRatio);
    }

    [Fact]
    public void GlobalResetClearsEveryOverrideAndPreservesDetachedSnapshots()
    {
        var store = new AccessPointStateStore();
        var original = store.GetAll().ToArray();
        var peak = store.SetEventPosition(360);
        foreach (var ap in original) store.TrySetScenario(ap.ApId, AccessPointScenario.Offline, out _);
        var reset = store.ResetEventDay();
        Assert.Equal(original, reset.AccessPoints);
        Assert.Equal("baseline", reset.Mode);
        Assert.Equal(84, peak.AccessPoints[0].Clients);
        Assert.All(peak.AccessPoints, ap => Assert.True(ap.Operational));
    }

    [Fact]
    public void AllMinutesStayBoundedAndProgressMonotonicallyWithinEachLoadDirection()
    {
        var store = new AccessPointStateStore();
        var previous = store.SetEventPosition(0).AccessPoints;
        for (var minute = 1; minute <= 660; minute++)
        {
            var current = store.SetEventPosition(minute).AccessPoints;
            for (var i = 0; i < 4; i++)
            {
                Assert.InRange(current[i].ChannelUtilizationRatio!.Value, 0, 1);
                Assert.InRange(current[i].ManagementPacketLossRatio!.Value, 0, 1);
                Assert.True(minute <= 480 ? current[i].Clients >= previous[i].Clients : current[i].Clients <= previous[i].Clients);
                Assert.True(minute <= 480 ? current[i].ChannelUtilizationRatio >= previous[i].ChannelUtilizationRatio : current[i].ChannelUtilizationRatio <= previous[i].ChannelUtilizationRatio);
                Assert.True(minute <= 480 ? current[i].ManagementLatencySeconds >= previous[i].ManagementLatencySeconds : current[i].ManagementLatencySeconds <= previous[i].ManagementLatencySeconds);
                Assert.True(minute <= 480 ? current[i].ManagementPacketLossRatio >= previous[i].ManagementPacketLossRatio : current[i].ManagementPacketLossRatio <= previous[i].ManagementPacketLossRatio);
            }
            previous = current;
        }
    }
}
