namespace VenueOps.Api;

public sealed class IncidentEvent
{
    private IncidentEvent() { }
    internal IncidentEvent(DateTimeOffset occurredAtUtc, string? responderLabel)
    {
        OccurredAtUtc = occurredAtUtc;
        Sequence = 1;
        ToStatus = "Open";
        ResponderLabel = responderLabel;
    }
    internal IncidentEvent(long incidentId, long sequence, IncidentCommand command, DateTimeOffset occurredAtUtc,
        string previousStatus, string? previousResponder)
    {
        IncidentId = incidentId; Sequence = sequence; CommandId = command.CommandId;
        Kind = command.Kind; OccurredAtUtc = occurredAtUtc; Text = command.Text;
        if (Kind == "StatusChanged") { FromStatus = previousStatus; ToStatus = command.Status; }
        if (Kind == "ResponderChanged") { PreviousResponderLabel = previousResponder; ResponderLabel = command.ResponderLabel; }
    }
    public long Id { get; private set; }
    public long IncidentId { get; private set; }
    public string Kind { get; private set; } = "Created";
    public DateTimeOffset OccurredAtUtc { get; private set; }
    public long Sequence { get; private set; }
    public Guid? CommandId { get; private set; }
    public string? Text { get; private set; }
    public string? FromStatus { get; private set; }
    public string? ToStatus { get; private set; }
    public string? PreviousResponderLabel { get; private set; }
    public string? ResponderLabel { get; private set; }

    public bool Matches(IncidentCommand command) => CommandId == command.CommandId && Kind == command.Kind
        && Sequence - 1 == command.ExpectedVersion && Text == command.Text && ToStatus == command.Status
        && ResponderLabel == command.ResponderLabel;
    public IncidentEventResponse ToResponse() => new(Id, Kind, OccurredAtUtc, Sequence, CommandId, Text,
        FromStatus, ToStatus, PreviousResponderLabel, ResponderLabel);
    public IncidentCommandReceipt ToReceipt() => new(IncidentId,
        CommandId ?? throw new InvalidOperationException("Created events are not workflow command receipts."), Sequence, ToResponse());
}
