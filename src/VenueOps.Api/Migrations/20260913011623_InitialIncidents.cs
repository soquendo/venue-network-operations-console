using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace VenueOps.Api.Migrations
{
    /// <inheritdoc />
    public partial class InitialIncidents : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Incidents",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Zone = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    ResponderLabel = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    CreatedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    MonitoringCaptureAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    OverviewGeneratedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Incidents", x => x.Id);
                    table.CheckConstraint("CK_Incident_Open", "\"Status\" = 'Open'");
                });

            migrationBuilder.CreateTable(
                name: "IncidentAccessPoints",
                columns: table => new
                {
                    IncidentId = table.Column<long>(type: "bigint", nullable: false),
                    ApId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Zone = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Operational = table.Column<bool>(type: "boolean", nullable: false),
                    Degraded = table.Column<bool>(type: "boolean", nullable: false),
                    Clients = table.Column<int>(type: "integer", nullable: false),
                    ChannelUtilizationRatio = table.Column<double>(type: "double precision", nullable: true),
                    ManagementLatencySeconds = table.Column<double>(type: "double precision", nullable: true),
                    ManagementPacketLossRatio = table.Column<double>(type: "double precision", nullable: true),
                    AlertState = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    DegradationAlertState = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Source = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    ObservedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    DownAlert_Name = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    DownAlert_State = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    DownAlert_Severity = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    DownAlert_TelemetrySource = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    DownAlert_ApId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    DownAlert_Zone = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    DownAlert_ObservedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    DegradationAlert_Name = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    DegradationAlert_State = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    DegradationAlert_Severity = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    DegradationAlert_TelemetrySource = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    DegradationAlert_ApId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    DegradationAlert_Zone = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    DegradationAlert_ObservedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_IncidentAccessPoints", x => new { x.IncidentId, x.ApId });
                    table.ForeignKey(
                        name: "FK_IncidentAccessPoints_Incidents_IncidentId",
                        column: x => x.IncidentId,
                        principalTable: "Incidents",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "IncidentEvents",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    IncidentId = table.Column<long>(type: "bigint", nullable: false),
                    Kind = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    OccurredAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_IncidentEvents", x => x.Id);
                    table.ForeignKey(
                        name: "FK_IncidentEvents_Incidents_IncidentId",
                        column: x => x.IncidentId,
                        principalTable: "Incidents",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_IncidentEvents_IncidentId_Kind",
                table: "IncidentEvents",
                columns: new[] { "IncidentId", "Kind" },
                unique: true,
                filter: "\"Kind\" = 'Created'");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "IncidentAccessPoints");

            migrationBuilder.DropTable(
                name: "IncidentEvents");

            migrationBuilder.DropTable(
                name: "Incidents");
        }
    }
}
