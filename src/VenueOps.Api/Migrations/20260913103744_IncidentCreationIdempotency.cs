using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VenueOps.Api.Migrations
{
    /// <inheritdoc />
    public partial class IncidentCreationIdempotency : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "CreationCommandId",
                table: "Incidents",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Incidents_CreationCommandId",
                table: "Incidents",
                column: "CreationCommandId",
                unique: true,
                filter: "\"CreationCommandId\" IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Incidents_CreationCommandId",
                table: "Incidents");

            migrationBuilder.DropColumn(
                name: "CreationCommandId",
                table: "Incidents");
        }
    }
}
