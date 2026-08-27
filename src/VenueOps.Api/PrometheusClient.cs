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

    public async Task<OperationsOverviewResponse> GetOperationsOverviewAsync(
        CancellationToken cancellationToken)
    {
        var operationalTask = QueryVectorAsync("venue_ap_operational", cancellationToken);
        var clientsTask = QueryVectorAsync("venue_ap_clients", cancellationToken);
        var channelUtilizationTask = QueryVectorAsync(
            "venue_ap_channel_utilization_ratio",
            cancellationToken);
        var managementLatencyTask = QueryVectorAsync(
            "venue_ap_management_latency_seconds",
            cancellationToken);
        var managementPacketLossTask = QueryVectorAsync(
            "venue_ap_management_packet_loss_ratio",
            cancellationToken);
        var zoneOperationalTask = QueryVectorAsync(
            "zone:venue_ap_operational:avg",
            cancellationToken);
        var zoneClientsTask = QueryVectorAsync(
            "zone:venue_ap_clients:sum",
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
        var alertsTask = QueryVectorAsync(
            "ALERTS{alertname=\"VenueApDown\"}",
            cancellationToken);

        await Task.WhenAll(
            operationalTask,
            clientsTask,
            channelUtilizationTask,
            managementLatencyTask,
            managementPacketLossTask,
            zoneOperationalTask,
            zoneClientsTask,
            scrapeTask,
            probeSuccessTask,
            probeDurationTask,
            probeStatusTask,
            alertsTask);

        var operational = IndexAccessPointSamples(
            await operationalTask,
            "venue_ap_operational");
        if (operational.Count != 4)
        {
            throw new PrometheusQueryException(
                $"Expected four venue_ap_operational series, but received {operational.Count}.");
        }

        var clients = IndexAccessPointSamples(await clientsTask, "venue_ap_clients");
        var channelUtilization = IndexAccessPointSamples(
            await channelUtilizationTask,
            "venue_ap_channel_utilization_ratio");
        var managementLatency = IndexAccessPointSamples(
            await managementLatencyTask,
            "venue_ap_management_latency_seconds");
        var managementPacketLoss = IndexAccessPointSamples(
            await managementPacketLossTask,
            "venue_ap_management_packet_loss_ratio");

        EnsureExactAccessPointSet(operational.Keys, clients.Keys, "venue_ap_clients");
        EnsureNoUnknownAccessPoints(
            operational.Keys,
            channelUtilization.Keys,
            "venue_ap_channel_utilization_ratio");
        EnsureNoUnknownAccessPoints(
            operational.Keys,
            managementLatency.Keys,
            "venue_ap_management_latency_seconds");
        EnsureNoUnknownAccessPoints(
            operational.Keys,
            managementPacketLoss.Keys,
            "venue_ap_management_packet_loss_ratio");

        var alertStates = IndexAlertStates(await alertsTask, operational.Keys);
        var accessPoints = operational
            .OrderBy(pair => pair.Key.ApId, StringComparer.Ordinal)
            .Select(pair =>
            {
                var key = pair.Key;
                var operationalSample = pair.Value;
                EnsureBinary(operationalSample.Value, "venue_ap_operational");
                var isOperational = operationalSample.Value == 1;

                var clientSample = clients[key];
                var clientCount = ReadNonNegativeWholeNumber(
                    clientSample.Value,
                    "venue_ap_clients");

                double? channelUtilizationRatio = null;
                double? managementLatencySeconds = null;
                double? managementPacketLossRatio = null;

                if (isOperational)
                {
                    var channelSample = ReadRequiredAccessPointSample(
                        channelUtilization,
                        key,
                        "venue_ap_channel_utilization_ratio");
                    EnsureRatio(
                        channelSample.Value,
                        "venue_ap_channel_utilization_ratio");
                    channelUtilizationRatio = channelSample.Value;

                    var latencySample = ReadRequiredAccessPointSample(
                        managementLatency,
                        key,
                        "venue_ap_management_latency_seconds");
                    if (latencySample.Value < 0)
                    {
                        throw new PrometheusQueryException(
                            "venue_ap_management_latency_seconds cannot be negative.");
                    }

                    managementLatencySeconds = latencySample.Value;

                    var lossSample = ReadRequiredAccessPointSample(
                        managementPacketLoss,
                        key,
                        "venue_ap_management_packet_loss_ratio");
                    EnsureRatio(
                        lossSample.Value,
                        "venue_ap_management_packet_loss_ratio");
                    managementPacketLossRatio = lossSample.Value;
                }

                var alertState = alertStates.GetValueOrDefault(key, "inactive");

                return new OperationsAccessPointObservation(
                    key.ApId,
                    key.Zone,
                    isOperational,
                    clientCount,
                    channelUtilizationRatio,
                    managementLatencySeconds,
                    managementPacketLossRatio,
                    alertState,
                    "simulated",
                    operationalSample.ObservedAtUtc);
            })
            .ToArray();

        var zoneOperational = IndexZoneSamples(
            await zoneOperationalTask,
            "zone:venue_ap_operational:avg");
        var zoneClients = IndexZoneSamples(
            await zoneClientsTask,
            "zone:venue_ap_clients:sum");
        if (zoneOperational.Count != 2)
        {
            throw new PrometheusQueryException(
                $"Expected two zone:venue_ap_operational:avg series, but received {zoneOperational.Count}.");
        }

        EnsureExactZoneSet(
            zoneOperational.Keys,
            zoneClients.Keys,
            "zone:venue_ap_clients:sum");
        EnsureExactZoneSet(
            operational.Keys.Select(key => key.Zone).Distinct(StringComparer.Ordinal),
            zoneOperational.Keys,
            "zone:venue_ap_operational:avg");

        var zones = zoneOperational
            .OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .Select(pair =>
            {
                EnsureRatio(pair.Value.Value, "zone:venue_ap_operational:avg");
                var clientsSample = zoneClients[pair.Key];
                var clientCount = ReadNonNegativeWholeNumber(
                    clientsSample.Value,
                    "zone:venue_ap_clients:sum");

                return new OperationsZoneObservation(
                    pair.Key,
                    pair.Value.Value,
                    clientCount,
                    "derived",
                    pair.Value.ObservedAtUtc);
            })
            .ToArray();

        var scrape = await scrapeTask;
        EnsureBinary(scrape.Value, "up");

        return new OperationsOverviewResponse(
            DateTimeOffset.UtcNow,
            accessPoints,
            zones,
            BuildProbeObservation(
                await probeSuccessTask,
                await probeDurationTask,
                await probeStatusTask),
            new ScrapeObservation(
                scrape.Value == 1,
                scrape.Value,
                "measured",
                scrape.ObservedAtUtc));
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

    private static Dictionary<AccessPointSeriesKey, PrometheusSample> IndexAccessPointSamples(
        IReadOnlyList<PrometheusSample> samples,
        string metric)
    {
        var indexed = new Dictionary<AccessPointSeriesKey, PrometheusSample>();

        foreach (var sample in samples)
        {
            var key = new AccessPointSeriesKey(
                ReadRequiredLabel(sample, "ap_id", metric),
                ReadRequiredLabel(sample, "zone", metric));
            if (!indexed.TryAdd(key, sample))
            {
                throw new PrometheusQueryException(
                    $"{metric} returned duplicate series for {key.ApId} in {key.Zone}.");
            }
        }

        return indexed;
    }

    private static Dictionary<string, PrometheusSample> IndexZoneSamples(
        IReadOnlyList<PrometheusSample> samples,
        string metric)
    {
        var indexed = new Dictionary<string, PrometheusSample>(StringComparer.Ordinal);

        foreach (var sample in samples)
        {
            var zone = ReadRequiredLabel(sample, "zone", metric);
            if (!indexed.TryAdd(zone, sample))
            {
                throw new PrometheusQueryException(
                    $"{metric} returned duplicate series for {zone}.");
            }
        }

        return indexed;
    }

    private static Dictionary<AccessPointSeriesKey, string> IndexAlertStates(
        IReadOnlyList<PrometheusSample> alerts,
        IEnumerable<AccessPointSeriesKey> knownAccessPoints)
    {
        var known = knownAccessPoints.ToHashSet();
        var states = new Dictionary<AccessPointSeriesKey, string>();

        foreach (var alert in alerts)
        {
            var key = new AccessPointSeriesKey(
                ReadRequiredLabel(alert, "ap_id", "VenueApDown alert"),
                ReadRequiredLabel(alert, "zone", "VenueApDown alert"));
            if (!known.Contains(key))
            {
                throw new PrometheusQueryException(
                    $"VenueApDown returned an unknown access point {key.ApId} in {key.Zone}.");
            }

            if (alert.Value != 1)
            {
                throw new PrometheusQueryException(
                    "Prometheus returned an invalid VenueApDown alert value.");
            }

            var state = ReadRequiredLabel(alert, "alertstate", "VenueApDown alert");
            if (state is not ("pending" or "firing"))
            {
                throw new PrometheusQueryException(
                    $"Prometheus returned unknown alert state '{state}'.");
            }

            if (!states.TryAdd(key, state))
            {
                throw new PrometheusQueryException(
                    $"Prometheus returned duplicate VenueApDown alerts for {key.ApId}.");
            }
        }

        return states;
    }

    private static void EnsureExactAccessPointSet(
        IEnumerable<AccessPointSeriesKey> expected,
        IEnumerable<AccessPointSeriesKey> actual,
        string metric)
    {
        var expectedSet = expected.ToHashSet();
        var actualSet = actual.ToHashSet();
        if (!expectedSet.SetEquals(actualSet))
        {
            throw new PrometheusQueryException(
                $"{metric} did not contain exactly the access points reported by venue_ap_operational.");
        }
    }

    private static void EnsureNoUnknownAccessPoints(
        IEnumerable<AccessPointSeriesKey> expected,
        IEnumerable<AccessPointSeriesKey> actual,
        string metric)
    {
        var expectedSet = expected.ToHashSet();
        if (actual.Any(key => !expectedSet.Contains(key)))
        {
            throw new PrometheusQueryException(
                $"{metric} returned an access point not present in venue_ap_operational.");
        }
    }

    private static void EnsureExactZoneSet(
        IEnumerable<string> expected,
        IEnumerable<string> actual,
        string metric)
    {
        var expectedSet = expected.ToHashSet(StringComparer.Ordinal);
        var actualSet = actual.ToHashSet(StringComparer.Ordinal);
        if (!expectedSet.SetEquals(actualSet))
        {
            throw new PrometheusQueryException(
                $"{metric} did not contain exactly the expected zones.");
        }
    }

    private static PrometheusSample ReadRequiredAccessPointSample(
        IReadOnlyDictionary<AccessPointSeriesKey, PrometheusSample> samples,
        AccessPointSeriesKey key,
        string metric)
    {
        if (!samples.TryGetValue(key, out var sample))
        {
            throw new PrometheusQueryException(
                $"{metric} omitted operational access point {key.ApId} in {key.Zone}.");
        }

        return sample;
    }

    private static int ReadNonNegativeWholeNumber(double value, string metric)
    {
        if (value < 0 || value != Math.Truncate(value) || value > int.MaxValue)
        {
            throw new PrometheusQueryException(
                $"{metric} must be a non-negative whole number.");
        }

        return checked((int)value);
    }

    private static ProbeObservation BuildProbeObservation(
        PrometheusSample probeSuccess,
        PrometheusSample probeDuration,
        PrometheusSample probeStatus)
    {
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
            throw new PrometheusQueryException(
                "probe_http_status_code was not a valid HTTP status code.");
        }

        return new ProbeObservation(
            ProbeTarget,
            probeSuccess.Value == 1,
            probeDuration.Value,
            checked((int)probeStatus.Value),
            "measured",
            probeSuccess.ObservedAtUtc);
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

    private readonly record struct AccessPointSeriesKey(string ApId, string Zone);
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

public sealed record OperationsOverviewResponse(
    DateTimeOffset GeneratedAtUtc,
    IReadOnlyList<OperationsAccessPointObservation> AccessPoints,
    IReadOnlyList<OperationsZoneObservation> Zones,
    ProbeObservation Probe,
    ScrapeObservation SimulatorScrape);

public sealed record OperationsAccessPointObservation(
    string ApId,
    string Zone,
    bool Operational,
    int Clients,
    double? ChannelUtilizationRatio,
    double? ManagementLatencySeconds,
    double? ManagementPacketLossRatio,
    string AlertState,
    string Source,
    DateTimeOffset ObservedAtUtc);

public sealed record OperationsZoneObservation(
    string Zone,
    double OperationalRatio,
    int Clients,
    string Source,
    DateTimeOffset ObservedAtUtc);
