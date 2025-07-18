# AI Backend Service

A standalone microservice that provides AI-powered functionality for the Workfolio ecosystem. This service integrates with external AI APIs to enhance the portfolio experience with intelligent features.

## Architecture

This service is part of a larger ecosystem of specialized, independently deployable services:

```
/your-projects/
├── workfolio/       # Front-end React application
├── ai-backend/      # This service - AI functionality
├── arachne/         # Web scraping service
└── buildsync/       # Full-stack application
```

## Features

- **AI Integration**: Connects to external AI APIs for intelligent features
- **RESTful API**: Provides clean endpoints for front-end consumption
- **Independent Deployment**: Can be deployed and scaled independently
- **Microservice Architecture**: Designed as a standalone service in the ecosystem

## Quick Start

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd ai-backend

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your configuration

# Start the development server
npm run dev
```

### Environment Variables

Create a `.env` file with the following variables:

```env
# Server Configuration
PORT=3001
NODE_ENV=development

# AI Service API Keys (set one or both)
GEMINI_API_KEY=your_gemini_api_key_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# CORS Configuration
CORS_ORIGIN=http://localhost:3000
```

#### Setting up Gemini API

1. **Get a Free API Key**:
   - Go to [Google AI Studio](https://aistudio.google.com/)
   - Sign in with your Google account
   - Click the "Get API key" button (</>) on the left sidebar
   - Click "+ Create API key in new project"
   - Copy the generated API key

2. **Configure the API Key**:
   - Copy `.env.example` to `.env`
   - Replace `your_gemini_api_key_here` with your actual API key

**Note**: The Gemini API offers a generous free tier with 60 requests per minute, perfect for development and personal projects.

## API Endpoints

### Health Check
- `GET /health` - Service health status

### AI Features
- `POST /chat` - AI chat endpoint
  - Request body: `{ message: string, history?: array, context?: string }`
  - Response: `{ response: string, timestamp: number }`

## Development

### Scripts

```bash
npm run dev      # Start development server
npm run start    # Start production server
npm run test     # Run tests
npm run lint     # Run linting
```

### Project Structure

```
ai-backend/
├── server.js          # Main server file
├── package.json       # Dependencies and scripts
├── .env.example       # Environment variables template
├── .gitignore         # Git ignore rules
└── README.md          # This file
```

## Deployment

This service is designed to be deployed independently. Common deployment options include:

- **Heroku**: Simple deployment with `git push heroku main`
- **Railway**: Easy deployment with automatic scaling
- **DigitalOcean App Platform**: Managed container deployment
- **AWS Lambda**: Serverless deployment
- **Docker**: Containerized deployment

### Docker Deployment

```bash
# Build the image
docker build -t ai-backend .

# Run the container
docker run -p 3001:3001 ai-backend
```

## Integration with Workfolio

The Workfolio front-end application consumes this service via HTTP requests. The service is designed to be stateless and can handle multiple concurrent requests from the front-end.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Ecosystem

This service is part of a larger portfolio ecosystem:

- **[Workfolio](https://github.com/yourusername/workfolio)**: The main portfolio front-end
- **[Arachne](https://github.com/yourusername/arachne)**: Web scraping service
- **[BuildSync](https://github.com/yourusername/buildsync)**: Full-stack application

Each service is designed to be independent while working together to create a comprehensive portfolio experience. 