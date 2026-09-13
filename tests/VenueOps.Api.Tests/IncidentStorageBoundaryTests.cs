using System.Reflection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using VenueOps.Api;
using Xunit;

namespace VenueOps.Api.Tests;

public sealed class IncidentStorageBoundaryTests
{
    private static PostgresException Provider(string state) => new("Private provider message", "FATAL", "FATAL", state);

    // Exercise the real shared endpoint boundary without a database, test host,
    // or additional production visibility solely for the tests.
    private static Task<IResult> Execute(Func<CancellationToken, Task<IResult>> action, CancellationToken cancellation = default) =>
        (Task<IResult>)typeof(IncidentEndpoints).GetMethod("ExecuteAsync", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, [action, cancellation])!;

    private static Task<IResult> Fail(Exception exception) => Execute(_ => Task.FromException<IResult>(exception));

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public async Task AdministrativeTerminationIsBoundedStorage503ThroughWrappers(int levels)
    {
        Exception exception = Provider(PostgresErrorCodes.AdminShutdown);
        for (var i = 0; i < levels; i++) exception = new InvalidOperationException("EF execution wrapper", exception);
        var result = Assert.IsType<ProblemHttpResult>(await Fail(exception));
        Assert.Equal(503, result.StatusCode);
        Assert.Equal("Incident storage is unavailable", result.ProblemDetails.Title);
        Assert.Null(result.ProblemDetails.Detail);
        Assert.Empty(result.ProblemDetails.Extensions);
    }

    [Theory]
    [InlineData("08006")]
    [InlineData("28000")]
    [InlineData("28P01")]
    [InlineData("57P02")]
    [InlineData("57P03")]
    public async Task WrappedConnectionOrAccessFailureIsStorage503(string state)
    {
        var result = Assert.IsType<ProblemHttpResult>(await Fail(new InvalidOperationException("Provider wrapper", Provider(state))));
        Assert.Equal(503, result.StatusCode);
        Assert.Equal("Incident storage is unavailable", result.ProblemDetails.Title);
    }

    [Fact]
    public async Task WrappedNpgsqlNetworkFailureIsStorage503()
    {
        var exception = new InvalidOperationException("Provider wrapper", new NpgsqlException("Network failure", new IOException("Connection closed")));
        Assert.Equal(503, Assert.IsType<ProblemHttpResult>(await Fail(exception)).StatusCode);
    }

    [Fact]
    public async Task ExplicitStorageUnavailableKeepsExisting503() =>
        Assert.Equal(503, Assert.IsType<ProblemHttpResult>(await Fail(new IncidentStorageUnavailableException())).StatusCode);

    [Theory]
    [InlineData("23505")]
    [InlineData("23514")]
    [InlineData("40001")]
    [InlineData("40P01")]
    [InlineData("22021")]
    public async Task WrappedConstraintConcurrencyOrInputErrorIsNotReclassified(string state)
    {
        var exception = new InvalidOperationException("Unowned provider error", Provider(state));
        Assert.Same(exception, await Assert.ThrowsAsync<InvalidOperationException>(() => Fail(exception)));
    }

    [Theory]
    [InlineData("23505")]
    [InlineData("40001")]
    [InlineData("40P01")]
    public async Task ProviderWrapperDoesNotHideAnInnerTransactionConflict(string state)
    {
        var exception = new InvalidOperationException("EF wrapper", new NpgsqlException("Provider wrapper", Provider(state)));
        Assert.Same(exception, await Assert.ThrowsAsync<InvalidOperationException>(() => Fail(exception)));
    }

    [Fact]
    public async Task PlainInvalidOperationIsNotSwallowed()
    {
        var exception = new InvalidOperationException("Application bug");
        Assert.Same(exception, await Assert.ThrowsAsync<InvalidOperationException>(() => Fail(exception)));
    }

    [Fact]
    public async Task NestedApplicationFailureIsNotSwallowed()
    {
        var exception = new InvalidOperationException("Application bug", new ArgumentException("Invalid state"));
        Assert.Same(exception, await Assert.ThrowsAsync<InvalidOperationException>(() => Fail(exception)));
    }

    [Fact]
    public async Task WrappedOptimisticConcurrencyIsNotSwallowed()
    {
        var exception = new InvalidOperationException("Unowned concurrency error", new DbUpdateConcurrencyException());
        Assert.Same(exception, await Assert.ThrowsAsync<InvalidOperationException>(() => Fail(exception)));
    }

    [Fact]
    public async Task UnrelatedTimeoutIsNotSwallowed()
    {
        var exception = new InvalidOperationException("Application operation", new TimeoutException());
        Assert.Same(exception, await Assert.ThrowsAsync<InvalidOperationException>(() => Fail(exception)));
    }

    [Theory]
    [InlineData("version_conflict")]
    [InlineData("state_conflict")]
    [InlineData("command_conflict")]
    [InlineData("responder_unchanged")]
    public async Task WorkflowConflictsKeepTheirCode(string code)
    {
        var result = Assert.IsType<ProblemHttpResult>(await Fail(new IncidentWorkflowConflictException(code, "Review", 2, "Open")));
        Assert.Equal(409, result.StatusCode);
        Assert.Equal(code, result.ProblemDetails.Extensions["code"]);
    }

    [Fact]
    public async Task ValidationRemains400() =>
        Assert.Equal(400, Assert.IsType<ProblemHttpResult>(await Fail(new IncidentValidationException("Invalid"))).StatusCode);

    [Fact]
    public async Task ConditionConflictRemains409()
    {
        var result = Assert.IsType<ProblemHttpResult>(await Fail(new IncidentConditionChangedException("Recovered")));
        Assert.Equal(409, result.StatusCode);
        Assert.Equal("condition_changed", result.ProblemDetails.Extensions["code"]);
    }

    [Fact]
    public async Task CreationConflictRemains409()
    {
        var result = Assert.IsType<ProblemHttpResult>(await Fail(new IncidentCreationConflictException("Different intent")));
        Assert.Equal(409, result.StatusCode);
        Assert.Equal("creation_command_conflict", result.ProblemDetails.Extensions["code"]);
    }

    [Fact]
    public async Task NotFoundResultRemains404() =>
        Assert.Equal(404, Assert.IsType<ProblemHttpResult>(await Execute(_ => Task.FromResult(Results.Problem(statusCode: 404, title: "Incident not found")))).StatusCode);

    [Fact]
    public async Task PrometheusFailureKeepsSeparate503()
    {
        var result = Assert.IsType<ProblemHttpResult>(await Fail(new PrometheusQueryException("Unavailable")));
        Assert.Equal(503, result.StatusCode);
        Assert.Equal("Prometheus telemetry is unavailable", result.ProblemDetails.Title);
    }
}
