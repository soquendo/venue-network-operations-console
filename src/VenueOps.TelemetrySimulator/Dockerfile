FROM mcr.microsoft.com/dotnet/sdk:10.0.401-alpine3.23 AS build
WORKDIR /src
COPY Directory.Build.props ./
COPY src/VenueOps.TelemetrySimulator/VenueOps.TelemetrySimulator.csproj src/VenueOps.TelemetrySimulator/
RUN dotnet restore src/VenueOps.TelemetrySimulator/VenueOps.TelemetrySimulator.csproj
COPY src/VenueOps.TelemetrySimulator/ src/VenueOps.TelemetrySimulator/
RUN dotnet publish src/VenueOps.TelemetrySimulator/VenueOps.TelemetrySimulator.csproj --configuration Release --no-restore --output /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0.12-alpine3.23
WORKDIR /app
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "VenueOps.TelemetrySimulator.dll"]
