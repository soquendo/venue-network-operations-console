using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace VenueOps.Api;

public sealed class PrometheusClient(HttpClient httpClient)
{
    private const string ApId = "ap-001";
    private const string Zone = "zone-a";
    private const string ProbeTarget = "http://venue-api:8080/health/live";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<ViabilityResponse> GetViabilityAsync(CancellationToken cancellationToken)
    {
        var apTask = QuerySingleAsync(
            $"venue_ap_operational{{ap_id=\"{ApId}\"}}",
            "AP operational metric",
            cancellationToken);
        var zoneTask = QuerySingleAsync(
            $"zone:venue_ap_operational:avg{{zone=\"{Zone}\"}}",
            "zone operational recording rule",
            cancellationToken);
        var scrapeTask = QuerySingleAsync(
            "up{job=\"venue-ap-simulator\"}",
            "simulator scrape metric",
            cancellationToken);
        var probeSuccessTask = QuerySingleAsync(
            $"probe_success{{job=\"blackbox-http\",instance=\"{ProbeTarget}\"}}",
            "Blackbox probe success metric",
            cancellationToken);
        var probeDurationTask = QuerySingleAsync(
            $"probe_duration_seconds{{job=\"blackbox-http\",instance=\"{ProbeTarget}\"}}",
            "Blackbox probe duration metric",
            cancellationToken);
        var probeStatusTask = QuerySingleAsync(
            $"probe_http_status_code{{job=\"blackbox-http\",instance=\"{ProbeTarget}\"}}",
            "Blackbox HTTP status metric",
            cancellationToken);
        var alertTask = QueryVectorAsync(
            $"ALERTS{{alertname=\"VenueApDown\",ap_id=\"{ApId}\"}}",
            cancellationToken);

        await Task.WhenAll(
            apTask,
            zoneTask,
            scrapeTask,
            probeSuccessTask,
            probeDurationTask,
            probeStatusTask,
            alertTask);

        var ap = await apTask;
        var zone = await zoneTask;
        var scrape = await scrapeTask;
        var probeSuccess = await probeSuccessTask;
        var probeDuration = await probeDurationTask;
        var probeStatus = await probeStatusTask;
        var alerts = await alertTask;

        EnsureBinary(ap.Value, "venue_ap_operational");
        EnsureRatio(zone.Value, "zone:venue_ap_operational:avg");
        EnsureBinary(scrape.Value, "up");
        EnsureBinary(probeSuccess.Value, "probe_success");

        if (probeDuration.Value < 0)
        {
            throw new PrometheusQueryException("probe_duration_seconds cannot be negative.");
        }

        var invalidStatusCode = probeStatus.Value < 0
            || probeStatus.Value > 599
            || probeStatus.Value != Math.Truncate(probeStatus.Value)
            || (probeSuccess.Value == 1 && probeStatus.Value < 100);
        if (invalidStatusCode)
        {
            throw new PrometheusQueryException("probe_http_status_code was not a valid HTTP status code.");
        }

        var alertState = ReadAlertState(alerts);
        var apZone = ReadRequiredLabel(ap, "zone", "AP operational metric");
        var returnedApId = ReadRequiredLabel(ap, "ap_id", "AP operational metric");

        return new ViabilityResponse(
            DateTimeOffset.UtcNow,
            new ApObservation(returnedApId, apZone, ap.Value == 1, ap.Value, "simulated", ap.ObservedAtUtc),
            new ZoneObservation(Zone, zone.Value, "derived", zone.ObservedAtUtc),
            new ProbeObservation(
                ProbeTarget,
                probeSuccess.Value == 1,
                probeDuration.Value,
                checked((int)probeStatus.Value),
                "measured",
                probeSuccess.ObservedAtUtc),
            new ScrapeObservation(scrape.Value == 1, scrape.Value, "measured", scrape.ObservedAtUtc),
            new AlertObservation("VenueApDown", alertState, "derived"));
    }

    private async Task<PrometheusSample> QuerySingleAsync(
        string expression,
        string description,
        CancellationToken cancellationToken)
    {
        var samples = await QueryVectorAsync(expression, cancellationToken);

        if (samples.Count != 1)
        {
            throw new PrometheusQueryException(
                $"Expected exactly one series for {description}, but received {samples.Count}.");
        }

        return samples[0];
    }

    private async Task<IReadOnlyList<PrometheusSample>> QueryVectorAsync(
        string expression,
        CancellationToken cancellationToken)
    {
        var requestUri = $"/api/v1/query?query={Uri.EscapeDataString(expression)}";
        using var response = await httpClient.GetAsync(requestUri, cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            throw new PrometheusQueryException(
                $"Prometheus query failed with HTTP status {(int)response.StatusCode}.");
        }

        await using var body = await response.Content.ReadAsStreamAsync(cancellationToken);
        PrometheusEnvelope? envelope;
        try
        {
            envelope = await JsonSerializer.DeserializeAsync<PrometheusEnvelope>(
                body,
                JsonOptions,
                cancellationToken);
        }
        catch (JsonException exception)
        {
            throw new PrometheusQueryException(
                $"Prometheus returned invalid JSON: {exception.Message}");
        }

        if (envelope?.Status != "success" || envelope.Data?.Result is null)
        {
            throw new PrometheusQueryException(
                $"Prometheus rejected the query: {envelope?.Error ?? "invalid response"}.");
        }

        if (envelope.Data.ResultType != "vector")
        {
            throw new PrometheusQueryException(
                $"Expected a Prometheus vector result, but received '{envelope.Data.ResultType}'.");
        }

        return envelope.Data.Result.Select(ParseSample).ToArray();
    }

    private static PrometheusSample ParseSample(PrometheusResult result)
    {
        if (result.Value.ValueKind != JsonValueKind.Array)
        {
            throw new PrometheusQueryException("Prometheus returned a malformed sample value.");
        }

        var values = result.Value.EnumerateArray().ToArray();
        if (values.Length != 2 || !values[0].TryGetDouble(out var timestampSeconds))
        {
            throw new PrometheusQueryException("Prometheus returned a malformed sample tuple.");
        }

        if (values[1].ValueKind != JsonValueKind.String)
        {
            throw new PrometheusQueryException("Prometheus returned a sample value that was not a string.");
        }

        var rawValue = values[1].GetString();
        if (!double.TryParse(rawValue, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
            || !double.IsFinite(value)
            || !double.IsFinite(timestampSeconds))
        {
            throw new PrometheusQueryException("Prometheus returned a non-finite or invalid sample.");
        }

        var timestampMilliseconds = checked((long)Math.Round(timestampSeconds * 1000));
        return new PrometheusSample(
            result.Metric ?? throw new PrometheusQueryException("Prometheus returned a sample without labels."),
            value,
            DateTimeOffset.FromUnixTimeMilliseconds(timestampMilliseconds));
    }

    private static string ReadAlertState(IReadOnlyList<PrometheusSample> alerts)
    {
        if (alerts.Count == 0)
        {
            return "inactive";
        }

        if (alerts.Count != 1)
        {
            throw new PrometheusQueryException(
                $"Expected at most one VenueApDown alert for {ApId}, but received {alerts.Count}.");
        }

        var state = ReadRequiredLabel(alerts[0], "alertstate", "VenueApDown alert");
        if (alerts[0].Value != 1)
        {
            throw new PrometheusQueryException("Prometheus returned an invalid VenueApDown alert value.");
        }

        if (state is not ("pending" or "firing"))
        {
            throw new PrometheusQueryException($"Prometheus returned unknown alert state '{state}'.");
        }

        return state;
    }

    private static string ReadRequiredLabel(
        PrometheusSample sample,
        string label,
        string description)
    {
        if (!sample.Metric.TryGetValue(label, out var value) || string.IsNullOrWhiteSpace(value))
        {
            throw new PrometheusQueryException($"{description} did not include required label '{label}'.");
        }

        return value;
    }

    private static void EnsureBinary(double value, string metric)
    {
        if (value is not (0 or 1))
        {
            throw new PrometheusQueryException($"{metric} must be either 0 or 1.");
        }
    }

    private static void EnsureRatio(double value, string metric)
    {
        if (value is < 0 or > 1)
        {
            throw new PrometheusQueryException($"{metric} must be between 0 and 1.");
        }
    }

    private sealed record PrometheusEnvelope(
        [property: JsonPropertyName("status")] string Status,
        [property: JsonPropertyName("data")] PrometheusData? Data,
        [property: JsonPropertyName("error")] string? Error);

    private sealed record PrometheusData(
        [property: JsonPropertyName("resultType")] string ResultType,
        [property: JsonPropertyName("result")] IReadOnlyList<PrometheusResult>? Result);

    private sealed record PrometheusResult(
        [property: JsonPropertyName("metric")] IReadOnlyDictionary<string, string>? Metric,
        [property: JsonPropertyName("value")] JsonElement Value);
}

public sealed record PrometheusSample(
    IReadOnlyDictionary<string, string> Metric,
    double Value,
    DateTimeOffset ObservedAtUtc);

public sealed class PrometheusQueryException(string message) : Exception(message);

public sealed record ViabilityResponse(
    DateTimeOffset GeneratedAtUtc,
    ApObservation Ap,
    ZoneObservation Zone,
    ProbeObservation Probe,
    ScrapeObservation SimulatorScrape,
    AlertObservation Alert);

public sealed record ApObservation(
    string ApId,
    string Zone,
    bool Operational,
    double Value,
    string Source,
    DateTimeOffset ObservedAtUtc);

public sealed record ZoneObservation(
    string Zone,
    double OperationalRatio,
    string Source,
    DateTimeOffset ObservedAtUtc);

public sealed record ProbeObservation(
    string Target,
    bool Success,
    double DurationSeconds,
    int HttpStatusCode,
    string Source,
    DateTimeOffset ObservedAtUtc);

public sealed record ScrapeObservation(
    bool Up,
    double Value,
    string Source,
    DateTimeOffset ObservedAtUtc);

public sealed record AlertObservation(string Name, string State, string Source);
