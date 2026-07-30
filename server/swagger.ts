import swaggerJsdoc from "swagger-jsdoc";

const isProduction = process.env.NODE_ENV === "production";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.3",
    info: {
      title: "North African Wildfire Observatory API",
      version: "1.0.0",
      description: "API for the North African Observatory for Forest Fires and Disasters. Monitors wildfires across Algeria, Tunisia, Morocco, and Libya.",
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

export default swaggerSpec;
