all: docker

docker:
	docker-compose -f deploy/docker-compose.dev.yml up --build -d
	@echo "Frontend is running at http://localhost:3000"
	@echo "Backend is running at http://localhost:4000"