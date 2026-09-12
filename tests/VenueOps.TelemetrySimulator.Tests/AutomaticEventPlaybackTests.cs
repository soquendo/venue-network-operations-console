using VenueOps.TelemetrySimulator;
using Xunit;

namespace VenueOps.TelemetrySimulator.Tests;

public sealed class AutomaticEventPlaybackTests
{
    [Theory]
    [InlineData("baseline")]
    [InlineData("held")]
    [InlineData("running")]
    [InlineData("completed")]
    public void StartAlwaysCreatesAFreshZeroPositionAndClearsEveryOverride(string previousMode)
    {
        var clock = new ControlledEventTimeProvider();
        var store = new AccessPointStateStore(clock);
        if (previousMode == "held") store.SetEventPosition(360);
        if (previousMode is "running" or "completed")
        {
            store.StartEventDay();
            clock.Advance(TimeSpan.FromSeconds(previousMode == "running" ? 360 : 900));
        }
        foreach (var ap in store.GetAll()) store.TrySetScenario(ap.ApId, AccessPointScenario.Offline, out _);

        var started = store.StartEventDay();

        Assert.Equal("running", started.Mode);
        EqualProfile(new AccessPointStateStore().SetEventPosition(0), started);
        Assert.All(started.AccessPoints, ap => Assert.Equal(AccessPointScenario.Healthy, ap.Scenario));
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(1, store.GetEventDay().ElapsedMinutes);
    }

    [Fact]
    public void StartReturnsTheAnchorSnapshotWithoutReadingTheClockAgain()
    {
        var clock = new ControlledEventTimeProvider { AdvanceOnRead = TimeSpan.FromSeconds(400) };
        var store = new AccessPointStateStore(clock);
        var started = store.StartEventDay();
        Assert.Equal(1, clock.TimestampReads);
        Assert.Equal("running", started.Mode);
        EqualProfile(new AccessPointStateStore().SetEventPosition(0), started);
        Assert.Equal(400, store.GetEventDay().ElapsedMinutes);
    }

    [Theory]
    [InlineData(0, 0, "PRE_OPEN", "running")]
    [InlineData(999, 0, "PRE_OPEN", "running")]
    [InlineData(1000, 1, "PRE_OPEN", "running")]
    [InlineData(149999, 149, "PRE_OPEN", "running")]
    [InlineData(150000, 150, "ARRIVAL", "running")]
    [InlineData(239999, 239, "ARRIVAL", "running")]
    [InlineData(240000, 240, "BUILDING_LOAD", "running")]
    [InlineData(359999, 359, "BUILDING_LOAD", "running")]
    [InlineData(360000, 360, "PEAK_DENSITY", "running")]
    [InlineData(479999, 479, "PEAK_DENSITY", "running")]
    [InlineData(480000, 480, "RECOVERY", "running")]
    [InlineData(659999, 659, "RECOVERY", "running")]
    [InlineData(660000, 660, "EVENT_CLOSE", "completed")]
    [InlineData(86400000, 660, "EVENT_CLOSE", "completed")]
    [InlineData(3153600000000L, 660, "EVENT_CLOSE", "completed")]
    public void FloorsElapsedSecondsAndClampsBeforeNarrowing(long milliseconds, int minute, string phase, string mode)
    {
        var clock = new ControlledEventTimeProvider();
        var store = new AccessPointStateStore(clock);
        store.StartEventDay();
        clock.Advance(TimeSpan.FromMilliseconds(milliseconds));
        var snapshot = store.GetEventDay();
        Assert.Equal(minute, snapshot.ElapsedMinutes);
        Assert.Equal(phase, snapshot.Phase);
        Assert.Equal(mode, snapshot.Mode);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(150)]
    [InlineData(240)]
    [InlineData(360)]
    [InlineData(480)]
    [InlineData(660)]
    public void ChangesPositionExactlyAtBoundaryNotOneTimestampTickBefore(int second)
    {
        var clock = new ControlledEventTimeProvider();
        var store = new AccessPointStateStore(clock);
        store.StartEventDay();
        clock.Advance(TimeSpan.FromTicks(second * TimeSpan.TicksPerSecond - 1));
        Assert.Equal(second - 1, store.GetEventDay().ElapsedMinutes);
        clock.Advance(TimeSpan.FromTicks(1));
        Assert.Equal(second, store.GetEventDay().ElapsedMinutes);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(75)]
    [InlineData(150)]
    [InlineData(195)]
    [InlineData(240)]
    [InlineData(275)]
    [InlineData(276)]
    [InlineData(300)]
    [InlineData(323)]
    [InlineData(324)]
    [InlineData(360)]
    [InlineData(480)]
    [InlineData(507)]
    [InlineData(508)]
    [InlineData(525)]
    [InlineData(543)]
    [InlineData(544)]
    [InlineData(570)]
    [InlineData(660)]
    public void AutomaticAndHeldPositionsHaveExactlyEquivalentProfileData(int minute)
    {
        var clock = new ControlledEventTimeProvider();
        var automatic = new AccessPointStateStore(clock);
        var manual = new AccessPointStateStore();
        automatic.StartEventDay();
        clock.Advance(TimeSpan.FromSeconds(minute));
        var actual = automatic.GetEventDay();
        EqualProfile(manual.SetEventPosition(minute), actual);
        Assert.Equal(minute == 660 ? "completed" : "running", actual.Mode);
        Assert.Equal("held", manual.GetEventDay().Mode);
        automatic.TrySetScenario("ap-002", AccessPointScenario.Offline, out _);
        manual.TrySetScenario("ap-002", AccessPointScenario.Offline, out _);
        EqualProfile(manual.GetEventDay(), automatic.GetEventDay());
        Assert.Equal(automatic.GetEventDay().AccessPoints, automatic.GetAll());
    }

    [Fact]
    public void AbsoluteMonotonicElapsedTimeDoesNotRequireReadsOrFollowCalendarChanges()
    {
        var clock = new ControlledEventTimeProvider();
        var store = new AccessPointStateStore(clock);
        store.StartEventDay();
        clock.UtcNow = clock.UtcNow.AddYears(10);
        Assert.Equal(0, store.GetEventDay().ElapsedMinutes);
        clock.Advance(TimeSpan.FromSeconds(525));
        clock.UtcNow = clock.UtcNow.AddYears(-20);
        EqualProfile(new AccessPointStateStore().SetEventPosition(525), store.GetEventDay());
    }

    [Theory]
    [InlineData(360)]
    [InlineData(900)]
    public void ManualPositionDiscardsRunningOrCompletedAnchorAndPreservesOverrides(int elapsed)
    {
        var clock = new ControlledEventTimeProvider();
        var store = new AccessPointStateStore(clock);
        store.StartEventDay();
        clock.Advance(TimeSpan.FromSeconds(elapsed));
        store.TrySetScenario("ap-001", AccessPointScenario.Offline, out _);
        var held = store.SetEventPosition(660);
        Assert.Equal("held", held.Mode);
        Assert.Equal("EVENT_CLOSE", held.Phase);
        Assert.False(held.AccessPoints[0].Operational);
        clock.Advance(TimeSpan.FromDays(1));
        Assert.Equal("held", store.GetEventDay().Mode);
        EqualProfile(held, store.GetEventDay());
    }

    [Theory]
    [InlineData("baseline")]
    [InlineData("held")]
    [InlineData("running")]
    [InlineData("completed")]
    public void ResetDiscardsAllStateAndFurtherClockAdvancementHasNoEffect(string mode)
    {
        var clock = new ControlledEventTimeProvider();
        var store = new AccessPointStateStore(clock);
        if (mode == "held") store.SetEventPosition(360);
        if (mode is "running" or "completed")
        {
            store.StartEventDay();
            clock.Advance(TimeSpan.FromSeconds(mode == "running" ? 360 : 660));
        }
        foreach (var ap in store.GetAll()) store.TrySetScenario(ap.ApId, AccessPointScenario.Offline, out _);
        store.ResetEventDay();
        clock.Advance(TimeSpan.FromDays(1));
        var reset = store.ResetEventDay();
        Assert.Equal("baseline", reset.Mode);
        EqualProfile(new AccessPointStateStore().GetEventDay(), reset);
        EqualProfile(reset, store.GetEventDay());
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(661)]
    public void InvalidPositionDoesNotStopOrRestartRunningTimeOrClearOverrides(int invalid)
    {
        var clock = new ControlledEventTimeProvider();
        var store = new AccessPointStateStore(clock);
        store.StartEventDay();
        clock.Advance(TimeSpan.FromSeconds(300));
        store.TrySetScenario("ap-001", AccessPointScenario.Offline, out _);
        Assert.Throws<ArgumentOutOfRangeException>(() => store.SetEventPosition(invalid));
        clock.Advance(TimeSpan.FromSeconds(60));
        var state = store.GetEventDay();
        Assert.Equal("running", state.Mode);
        Assert.Equal(360, state.ElapsedMinutes);
        Assert.False(state.AccessPoints[0].Operational);
    }

    [Fact]
    public void OfflineSurvivesPhaseChangesAndCompletionAndHealthyRejoinsCurrentPosition()
    {
        var clock = new ControlledEventTimeProvider();
        var store = new AccessPointStateStore(clock);
        store.StartEventDay();
        store.TrySetScenario("ap-001", AccessPointScenario.Offline, out _);
        clock.Advance(TimeSpan.FromSeconds(360));
        var offline = store.GetAll()[0];
        Assert.False(offline.Operational);
        Assert.Equal(0, offline.Clients);
        Assert.Null(offline.ChannelUtilizationRatio);
        Assert.Null(offline.ManagementLatencySeconds);
        Assert.Null(offline.ManagementPacketLossRatio);
        store.TrySetScenario("ap-001", AccessPointScenario.Healthy, out var rejoined);
        Assert.Equal(new AccessPointStateStore().SetEventPosition(360).AccessPoints[0], rejoined);
        store.TrySetScenario("ap-001", AccessPointScenario.Offline, out _);
        clock.Advance(TimeSpan.FromSeconds(300));
        var completed = store.GetEventDay();
        Assert.Equal("completed", completed.Mode);
        Assert.False(completed.AccessPoints[0].Operational);
        clock.Advance(TimeSpan.FromDays(2));
        EqualProfile(completed, store.GetEventDay());
        Assert.Equal("completed", store.GetEventDay().Mode);
        store.TrySetScenario("ap-001", AccessPointScenario.Healthy, out var restored);
        Assert.Equal(new AccessPointStateStore().GetAll()[0], restored);
    }

    [Fact]
    public void FreshStoreDoesNotResumeAnotherStoresRunOrOverrides()
    {
        var clock = new ControlledEventTimeProvider();
        var oldStore = new AccessPointStateStore(clock);
        oldStore.StartEventDay();
        oldStore.TrySetScenario("ap-001", AccessPointScenario.Offline, out _);
        clock.Advance(TimeSpan.FromSeconds(360));
        var fresh = new AccessPointStateStore(clock);
        Assert.Equal("baseline", fresh.GetEventDay().Mode);
        EqualProfile(new AccessPointStateStore().GetEventDay(), fresh.GetEventDay());
    }

    [Theory]
    [InlineData("status")]
    [InlineData("metrics")]
    [InlineData("override")]
    public void OneSnapshotResolvesTimeOnceEvenWhenASecondReadWouldCrossAPhase(string operation)
    {
        var clock = new ControlledEventTimeProvider();
        var store = new AccessPointStateStore(clock);
        store.StartEventDay();
        clock.Advance(TimeSpan.FromSeconds(239.999));
        clock.AdvanceOnRead = TimeSpan.FromSeconds(2);
        var before = clock.TimestampReads;
        var expected = new AccessPointStateStore().SetEventPosition(239);
        if (operation == "status") EqualProfile(expected, store.GetEventDay());
        else if (operation == "metrics") Assert.Equal(expected.AccessPoints, store.GetAll());
        else
        {
            store.TrySetScenario("ap-001", AccessPointScenario.Healthy, out var ap);
            Assert.Equal(expected.AccessPoints[0], ap);
        }
        Assert.Equal(before + 1, clock.TimestampReads);
    }

    private static void EqualProfile(EventDaySnapshot expected, EventDaySnapshot actual)
    {
        Assert.Equal(expected.Scenario, actual.Scenario);
        Assert.Equal(expected.ElapsedMinutes, actual.ElapsedMinutes);
        Assert.Equal(expected.Phase, actual.Phase);
        Assert.Equal(expected.NormalizedLoad, actual.NormalizedLoad);
        Assert.Equal(expected.AccessPoints, actual.AccessPoints);
    }
}

internal sealed class ControlledEventTimeProvider : TimeProvider
{
    private long _timestamp = 123 * TimeSpan.TicksPerSecond;
    private int _timestampReads;
    public override long TimestampFrequency => TimeSpan.TicksPerSecond;
    public int TimestampReads => Volatile.Read(ref _timestampReads);
    public TimeSpan AdvanceOnRead { get; set; }
    public DateTimeOffset UtcNow { get; set; } = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
    public override DateTimeOffset GetUtcNow() => UtcNow;
    public override long GetTimestamp()
    {
        Interlocked.Increment(ref _timestampReads);
        return Interlocked.Add(ref _timestamp, AdvanceOnRead.Ticks) - AdvanceOnRead.Ticks;
    }
    public void Advance(TimeSpan elapsed) => Interlocked.Add(ref _timestamp, elapsed.Ticks);
    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period) =>
        throw new InvalidOperationException("Lazy event playback must not create a timer.");
}
