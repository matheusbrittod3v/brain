/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true }
    },
    {
      name: "core-must-be-pure",
      severity: "error",
      from: { path: "^packages/core" },
      to: { path: "^(apps|packages/(?!core))" }
    }
  ]
};

