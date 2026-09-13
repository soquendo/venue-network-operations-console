namespace VenueOps.Api;

public sealed class IncidentEvent
{
    private IncidentEvent() { }
    internal IncidentEvent(DateTimeOffset occurredAtUtc) => OccurredAtUtc = occurredAtUtc;
    public long Id { get; private set; }
    public long IncidentId { get; private set; }
    public string Kind { get; private set; } = "Created";
    public DateTimeOffset OccurredAtUtc { get; private set; }
}
