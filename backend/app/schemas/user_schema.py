from pydantic import BaseModel, EmailStr, Field
from typing import Optional
from datetime import datetime
from app.models.sdap_models import UserRole


class UserCreate(BaseModel):
    email: EmailStr = Field(..., example="newuser@sdap.niruthi.in")
    full_name: str = Field(..., min_length=2, example="Niruthi Analyst")
    password: str = Field(..., min_length=6, example="User@123456")
    role: Optional[UserRole] = Field(UserRole.USER, example=UserRole.USER)


class UserResponse(BaseModel):
    id: int
    email: str
    full_name: str
    role: UserRole
    is_active: bool
    created_at: datetime
    request_count: Optional[int] = 0

    class Config:
        from_attributes = True



class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class PasswordResetRequest(BaseModel):
    email: EmailStr
    new_password: str = Field(..., min_length=6, example="NewUser@123456")
    confirm_password: str = Field(..., min_length=6, example="NewUser@123456")


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


