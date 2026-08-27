FROM mcr.microsoft.com/dotnet/sdk:10.0.302-alpine3.23 AS build
WORKDIR /src
COPY Directory.Build.props ./
COPY src/VenueOps.Api/VenueOps.Api.csproj src/VenueOps.Api/
RUN dotnet restore src/VenueOps.Api/VenueOps.Api.csproj
COPY src/VenueOps.Api/ src/VenueOps.Api/
RUN dotnet publish src/VenueOps.Api/VenueOps.Api.csproj --configuration Release --no-restore --output /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0.10-alpine3.23
WORKDIR /app
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "VenueOps.Api.dll"]
