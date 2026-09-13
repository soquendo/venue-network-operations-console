namespace VenueOps.Api;

// Constructed only after request validation; no arbitrary event payload is accepted.
public sealed class IncidentCommand
{
    internal IncidentCommand(Guid commandId, long expectedVersion, string kind, string? text = null, string? status = null, string? responderLabel = null)
    { CommandId = commandId; ExpectedVersion = expectedVersion; Kind = kind; Text = text; Status = status; ResponderLabel = responderLabel; }
    public Guid CommandId { get; }
    public long ExpectedVersion { get; }
    public string Kind { get; }
    public string? Text { get; }
    public string? Status { get; }
    public string? ResponderLabel { get; }
}

public static class IncidentWorkflow
{
    public const int PageSize = 100;

    public static IncidentCommand Note(AddIncidentNoteRequest request)
    {
        ValidateIdentity(request.CommandId, request.ExpectedVersion);
        var text = Normalize(request.Text, 2000, "Note");
        if (text is null) throw new IncidentValidationException("Note must contain non-whitespace text.");
        return new(request.CommandId, request.ExpectedVersion, "NoteAdded", text);
    }

    public static IncidentCommand Transition(TransitionIncidentRequest request)
    {
        ValidateIdentity(request.CommandId, request.ExpectedVersion);
        if (request.Status is not ("Open" or "Investigating" or "Monitoring" or "Resolved"))
            throw new IncidentValidationException("Status must be Open, Investigating, Monitoring, or Resolved.");
        return new(request.CommandId, request.ExpectedVersion, "StatusChanged", Normalize(request.Note, 2000, "Transition note"), request.Status);
    }

    public static IncidentCommand Responder(ChangeIncidentResponderRequest request)
    {
        ValidateIdentity(request.CommandId, request.ExpectedVersion);
        return new(request.CommandId, request.ExpectedVersion, "ResponderChanged", responderLabel: Normalize(request.ResponderLabel, 100, "Responder label"));
    }

    private static void ValidateIdentity(Guid commandId, long expectedVersion)
    {
        if (commandId == Guid.Empty) throw new IncidentValidationException("Command ID must be a non-empty UUID.");
        if (expectedVersion < 1) throw new IncidentValidationException("Expected version must be positive.");
    }

    private static string? Normalize(string? value, int limit, string field)
    {
        if (value?.Length > limit) throw new IncidentValidationException($"{field} must not exceed {limit} characters.");
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    public static void ValidateState(Incident incident, IncidentCommand command)
    {
        if (incident.Version != command.ExpectedVersion)
            throw Conflict(incident, "version_conflict", "This incident changed. Review current state before retrying.");
        if (command.Kind == "StatusChanged")
        {
            var allowed = (incident.Status, command.Status) switch
            {
                ("Open", "Investigating" or "Monitoring" or "Resolved") => true,
                ("Investigating", "Monitoring" or "Resolved") => true,
                ("Monitoring", "Investigating" or "Resolved") => true,
                ("Resolved", "Investigating") => true,
                _ => false
            };
            if (!allowed) throw Conflict(incident, "state_conflict", "This status transition is not allowed from the current state.");
            if ((command.Status == "Resolved" || incident.Status == "Resolved") && command.Text is null)
                throw new IncidentValidationException("Resolution and reopening require a non-empty note.");
        }
        if (command.Kind == "ResponderChanged")
        {
            if (incident.Status == "Resolved") throw Conflict(incident, "state_conflict", "Reopen the incident before changing its responder label.");
            if (incident.ResponderLabel == command.ResponderLabel)
                throw Conflict(incident, "responder_unchanged", "The responder label is unchanged.");
        }
    }

    public static IncidentWorkflowConflictException Conflict(Incident incident, string code, string message) =>
        new(code, message, incident.Version, incident.Status);

    public static void ValidateCursor(long? beforeEventSequence)
    {
        if (beforeEventSequence is <= 0) throw new IncidentValidationException("Before event sequence must be positive.");
    }

    public static IncidentEventPage Page(IEnumerable<IncidentEvent> entries, long capturedVersion, long? beforeEventSequence)
    {
        ValidateCursor(beforeEventSequence);
        var qualifying = entries.Where(e => e.Sequence <= capturedVersion && (!beforeEventSequence.HasValue || e.Sequence < beforeEventSequence))
            .OrderByDescending(e => e.Sequence).Take(PageSize + 1).ToArray();
        var page = qualifying.Take(PageSize).OrderBy(e => e.Sequence).Select(e => e.ToResponse()).ToArray();
        var earlier = qualifying.Length > PageSize;
        return new(page, earlier, earlier ? page[0].Sequence : null);
    }
}
