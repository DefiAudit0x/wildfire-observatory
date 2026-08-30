import swaggerJsdoc from "swagger-jsdoc";
import logger from "./logger.js";

const isProduction = process.env.NODE_ENV === "production";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.3",
    info: {
      title: "Algerian Wildfire and Disaster Observatory API",
      version: "1.0.0",
      description: "API for the Algerian Wildfire and Disaster Observatory. Monitors wildfires across Algeria, Tunisia, Morocco, and Libya.",
      contact: { name: "Nova DZ" },
    },
    servers: [
      { url: process.env.APP_URL || "http://localhost:3000", description: isProduction ? "Production" : "Development" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
  },
  apis: isProduction ? ["./dist/server/routes/*.js"] : ["./server/routes/*.ts"],
};

const swaggerSpec = swaggerJsdoc(options);

// ARC-L01 fix: production builds are a single esbuild bundle (dist/server.cjs),
// so the production glob "./dist/server/routes/*.js" matches nothing and
// /api-docs served an EMPTY spec with zero paths. Fail loudly at boot so the
// operator notices instead of shipping a blank documentation page.
if (Object.keys((swaggerSpec as any).paths || {}).length === 0) {
  logger.error(
    "[swagger] OpenAPI spec has ZERO paths — the apis glob no longer matches the build layout. /api-docs will be empty. Generate the spec at build time or fix the glob."
  );
}

export default swaggerSpec;
