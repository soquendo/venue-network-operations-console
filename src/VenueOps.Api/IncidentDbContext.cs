using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Npgsql;

namespace VenueOps.Api;

public sealed class IncidentDbContext(DbContextOptions<IncidentDbContext> options) : DbContext(options)
{
    public DbSet<Incident> Incidents => Set<Incident>();
    public DbSet<IncidentAccessPointContext> AccessPoints => Set<IncidentAccessPointContext>();
    public DbSet<IncidentEvent> Events => Set<IncidentEvent>();

    public static string ConnectionString(IConfiguration configuration) => new NpgsqlConnectionStringBuilder
    {
        Host = configuration["Incidents:Host"] ?? "incident-db",
        Database = configuration["Incidents:Database"] ?? "venueops_incidents",
        Username = configuration["Incidents:Username"] ?? "venueops",
        Password = configuration["Incidents:Password"] ?? "",
        Timeout = 3,
        CommandTimeout = 3,
        // This local password-authenticated service does not use Kerberos/GSS encryption.
        GssEncryptionMode = GssEncryptionMode.Disable
    }.ConnectionString;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        var incident = modelBuilder.Entity<Incident>();
        incident.ToTable("Incidents", table => table.HasCheckConstraint("CK_Incident_Open", "\"Status\" = 'Open'"));
        incident.HasKey(item => item.Id);
        incident.Property(item => item.Id).UseIdentityByDefaultColumn();
        incident.Property(item => item.Title).HasMaxLength(200);
        incident.Property(item => item.Zone).HasMaxLength(64);
        incident.Property(item => item.Status).HasMaxLength(20);
        incident.Property(item => item.ResponderLabel).HasMaxLength(100);
        incident.HasMany(item => item.AccessPoints).WithOne().HasForeignKey(item => item.IncidentId).OnDelete(DeleteBehavior.Restrict);
        incident.Navigation(item => item.AccessPoints).HasField("_accessPoints").UsePropertyAccessMode(PropertyAccessMode.Field);
        incident.HasMany(item => item.Events).WithOne().HasForeignKey(item => item.IncidentId).OnDelete(DeleteBehavior.Restrict);
        incident.Navigation(item => item.Events).HasField("_events").UsePropertyAccessMode(PropertyAccessMode.Field);

        var ap = modelBuilder.Entity<IncidentAccessPointContext>();
        ap.ToTable("IncidentAccessPoints");
        ap.HasKey(item => new { item.IncidentId, item.ApId });
        ap.Property(item => item.ApId).HasMaxLength(64);
        ap.Property(item => item.Zone).HasMaxLength(64);
        ap.Property(item => item.Source).HasMaxLength(32);
        ap.Property(item => item.AlertState).HasMaxLength(16);
        ap.Property(item => item.DegradationAlertState).HasMaxLength(16);
        ap.OwnsOne(item => item.DownAlert, ConfigureAlert);
        ap.OwnsOne(item => item.DegradationAlert, ConfigureAlert);

        var entry = modelBuilder.Entity<IncidentEvent>();
        entry.ToTable("IncidentEvents");
        entry.HasKey(item => item.Id);
        entry.Property(item => item.Id).UseIdentityByDefaultColumn();
        entry.Property(item => item.Kind).HasMaxLength(32);
        entry.HasIndex(item => new { item.IncidentId, item.Kind }).IsUnique().HasFilter("\"Kind\" = 'Created'");
    }

    private static void ConfigureAlert(OwnedNavigationBuilder<IncidentAccessPointContext, IncidentAlertObservation> alert)
    {
        alert.Property(item => item.Name).HasMaxLength(64);
        alert.Property(item => item.State).HasMaxLength(16);
        alert.Property(item => item.Severity).HasMaxLength(16);
        alert.Property(item => item.TelemetrySource).HasMaxLength(32);
        alert.Property(item => item.ApId).HasMaxLength(64);
        alert.Property(item => item.Zone).HasMaxLength(64);
    }
}
