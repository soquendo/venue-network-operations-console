using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Npgsql;

namespace VenueOps.Api;

public sealed class IncidentDbContext(DbContextOptions<IncidentDbContext> options) : DbContext(options)
{
    public const string CommandIndex = "IX_IncidentEvents_IncidentId_CommandId";
    public const string SequenceIndex = "IX_IncidentEvents_IncidentId_Sequence";
    public const string CreationIndex = "IX_Incidents_CreationCommandId";
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
        incident.ToTable("Incidents", table =>
        {
            table.HasCheckConstraint("CK_Incident_Status", "\"Status\" IN ('Open', 'Investigating', 'Monitoring', 'Resolved')");
            table.HasCheckConstraint("CK_Incident_Version", "\"Version\" > 0");
            table.HasCheckConstraint("CK_Incident_Resolution", "(\"Status\" = 'Resolved') = (\"ResolvedAtUtc\" IS NOT NULL)");
        });
        incident.HasKey(item => item.Id);
        incident.Property(item => item.Id).UseIdentityByDefaultColumn();
        incident.HasIndex(item => item.CreationCommandId).IsUnique()
            .HasFilter("\"CreationCommandId\" IS NOT NULL").HasDatabaseName(CreationIndex);
        incident.Property(item => item.Title).HasMaxLength(200);
        incident.Property(item => item.Zone).HasMaxLength(64);
        incident.Property(item => item.Status).HasMaxLength(20);
        incident.Property(item => item.ResponderLabel).HasMaxLength(100);
        incident.Property(item => item.Version).IsConcurrencyToken().HasDefaultValue(1L);
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
        entry.ToTable("IncidentEvents", table =>
        {
            table.HasCheckConstraint("CK_IncidentEvent_Sequence", "\"Sequence\" > 0");
            table.HasCheckConstraint("CK_IncidentEvent_Command", "(\"Kind\" = 'Created' AND \"Sequence\" = 1 AND \"CommandId\" IS NULL) OR (\"Kind\" IN ('NoteAdded', 'StatusChanged', 'ResponderChanged') AND \"Sequence\" > 1 AND \"CommandId\" IS NOT NULL)");
        });
        entry.HasKey(item => item.Id);
        entry.Property(item => item.Id).UseIdentityByDefaultColumn();
        entry.Property(item => item.Kind).HasMaxLength(32);
        entry.Property(item => item.Text).HasMaxLength(2000);
        entry.Property(item => item.FromStatus).HasMaxLength(20);
        entry.Property(item => item.ToStatus).HasMaxLength(20);
        entry.Property(item => item.PreviousResponderLabel).HasMaxLength(100);
        entry.Property(item => item.ResponderLabel).HasMaxLength(100);
        entry.HasIndex(item => new { item.IncidentId, item.Kind }).IsUnique().HasFilter("\"Kind\" = 'Created'");
        entry.HasIndex(item => new { item.IncidentId, item.Sequence }).IsUnique().HasDatabaseName(SequenceIndex);
        entry.HasIndex(item => new { item.IncidentId, item.CommandId }).IsUnique().HasFilter("\"CommandId\" IS NOT NULL").HasDatabaseName(CommandIndex);
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
