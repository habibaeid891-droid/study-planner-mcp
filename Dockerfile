# 🔹 Base image
FROM node:20

# 🔹 Create app directory
WORKDIR /app

# 🔹 Copy package files first (for caching)
COPY package.json ./

# 🔹 Install dependencies
RUN npm install --omit=dev

# 🔹 Copy app source
COPY . .

# 🔹 Start the app
CMD ["npm", "start"]
