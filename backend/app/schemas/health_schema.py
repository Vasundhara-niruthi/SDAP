from pydantic import BaseModel
from typing import Dict, Any


class HealthResponse(BaseModel):
    status: str
    project_name: str
    api_version: str
    database: Dict[str, Any]

