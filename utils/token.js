const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters.");
}

function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role
    },
    JWT_SECRET,
    {
      expiresIn: "1d",
      issuer: "rubalia-network"
    }
  );
}

module.exports = { generateToken };
