from pydantic import BaseModel, EmailStr, Field
from typing import Optional
from datetime import datetime


class UserCreate(BaseModel):
    email: EmailStr = Field(..., example="newuser@sdap.niruthi.in")
    full_name: str = Field(..., min_length=2, example="Niruthi Analyst")
    password: str = Field(..., min_length=6, example="User@123456")
    role: Optional[str] = Field("USER", example="USER") # 'ADMIN' or 'USER'


class UserResponse(BaseModel):
    id: int
    email: str
    full_name: str
    role: str
    is_active: bool
    created_at: datetime

    class Config:
        from_attributes = True


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse

