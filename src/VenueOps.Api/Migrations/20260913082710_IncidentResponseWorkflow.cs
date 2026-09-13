using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VenueOps.Api.Migrations
{
    /// <inheritdoc />
    public partial class IncidentResponseWorkflow : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "CK_Incident_Open",
                table: "Incidents");

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "ResolvedAtUtc",
                table: "Incidents",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "Version",
                table: "Incidents",
                type: "bigint",
                nullable: false,
                defaultValue: 1L);

            migrationBuilder.AddColumn<Guid>(
                name: "CommandId",
                table: "IncidentEvents",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "FromStatus",
                table: "IncidentEvents",
                type: "character varying(20)",
                maxLength: 20,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "PreviousResponderLabel",
                table: "IncidentEvents",
                type: "character varying(100)",
                maxLength: 100,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ResponderLabel",
                table: "IncidentEvents",
                type: "character varying(100)",
                maxLength: 100,
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "Sequence",
                table: "IncidentEvents",
                type: "bigint",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<string>(
                name: "Text",
                table: "IncidentEvents",
                type: "character varying(2000)",
                maxLength: 2000,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ToStatus",
                table: "IncidentEvents",
                type: "character varying(20)",
                maxLength: 20,
                nullable: true);

            // Task 1 has one Created event and no responder mutation. Preserve its
            // original fields while adding the initial chronology metadata.
            migrationBuilder.Sql("""
                UPDATE "IncidentEvents" AS entry
                SET "Sequence" = 1, "ToStatus" = 'Open', "ResponderLabel" = incident."ResponderLabel"
                FROM "Incidents" AS incident
                WHERE entry."IncidentId" = incident."Id" AND entry."Kind" = 'Created';
                """);

            migrationBuilder.AddCheckConstraint(
                name: "CK_Incident_Resolution",
                table: "Incidents",
                sql: "(\"Status\" = 'Resolved') = (\"ResolvedAtUtc\" IS NOT NULL)");

            migrationBuilder.AddCheckConstraint(
                name: "CK_Incident_Status",
                table: "Incidents",
                sql: "\"Status\" IN ('Open', 'Investigating', 'Monitoring', 'Resolved')");

            migrationBuilder.AddCheckConstraint(
                name: "CK_Incident_Version",
                table: "Incidents",
                sql: "\"Version\" > 0");

            migrationBuilder.CreateIndex(
                name: "IX_IncidentEvents_IncidentId_CommandId",
                table: "IncidentEvents",
                columns: new[] { "IncidentId", "CommandId" },
                unique: true,
                filter: "\"CommandId\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_IncidentEvents_IncidentId_Sequence",
                table: "IncidentEvents",
                columns: new[] { "IncidentId", "Sequence" },
                unique: true);

            migrationBuilder.AddCheckConstraint(
                name: "CK_IncidentEvent_Command",
                table: "IncidentEvents",
                sql: "(\"Kind\" = 'Created' AND \"Sequence\" = 1 AND \"CommandId\" IS NULL) OR (\"Kind\" IN ('NoteAdded', 'StatusChanged', 'ResponderChanged') AND \"Sequence\" > 1 AND \"CommandId\" IS NOT NULL)");

            migrationBuilder.AddCheckConstraint(
                name: "CK_IncidentEvent_Sequence",
                table: "IncidentEvents",
                sql: "\"Sequence\" > 0");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                DO $$ BEGIN
                    IF EXISTS (SELECT 1 FROM "IncidentEvents" WHERE "Sequence" > 1) THEN
                        RAISE EXCEPTION 'Cannot remove workflow schema containing response chronology; use a forward migration.';
                    END IF;
                END $$;
                """);
            migrationBuilder.DropCheckConstraint(
                name: "CK_Incident_Resolution",
                table: "Incidents");

            migrationBuilder.DropCheckConstraint(
                name: "CK_Incident_Status",
                table: "Incidents");

            migrationBuilder.DropCheckConstraint(
                name: "CK_Incident_Version",
                table: "Incidents");

            migrationBuilder.DropIndex(
                name: "IX_IncidentEvents_IncidentId_CommandId",
                table: "IncidentEvents");

            migrationBuilder.DropIndex(
                name: "IX_IncidentEvents_IncidentId_Sequence",
                table: "IncidentEvents");

            migrationBuilder.DropCheckConstraint(
                name: "CK_IncidentEvent_Command",
                table: "IncidentEvents");

            migrationBuilder.DropCheckConstraint(
                name: "CK_IncidentEvent_Sequence",
                table: "IncidentEvents");

            migrationBuilder.DropColumn(
                name: "ResolvedAtUtc",
                table: "Incidents");

            migrationBuilder.DropColumn(
                name: "Version",
                table: "Incidents");

            migrationBuilder.DropColumn(
                name: "CommandId",
                table: "IncidentEvents");

            migrationBuilder.DropColumn(
                name: "FromStatus",
                table: "IncidentEvents");

            migrationBuilder.DropColumn(
                name: "PreviousResponderLabel",
                table: "IncidentEvents");

            migrationBuilder.DropColumn(
                name: "ResponderLabel",
                table: "IncidentEvents");

            migrationBuilder.DropColumn(
                name: "Sequence",
                table: "IncidentEvents");

            migrationBuilder.DropColumn(
                name: "Text",
                table: "IncidentEvents");

            migrationBuilder.DropColumn(
                name: "ToStatus",
                table: "IncidentEvents");

            migrationBuilder.AddCheckConstraint(
                name: "CK_Incident_Open",
                table: "Incidents",
                sql: "\"Status\" = 'Open'");
        }
    }
}
