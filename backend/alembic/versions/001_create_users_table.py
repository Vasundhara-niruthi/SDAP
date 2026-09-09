"""create users table and user_id relationship

Revision ID: 001_create_users_table
Revises: 
Create Date: 2026-09-08 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '001_create_users_table'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Declare PostgreSQL UserRole Enum
user_role_enum = sa.Enum('ADMIN', 'USER', name='userrole')


def upgrade() -> None:
    """
    Upgrade schema: Create 'userrole' ENUM, 'users' table, indexes, and link foreign key to 'requests'.
    """
    # 1. Create PostgreSQL ENUM type for User Roles
    user_role_enum.create(op.get_bind(), checkfirst=True)

    # 2. Create 'users' table with ENUM role
    op.create_table(
        'users',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('email', sa.String(length=255), nullable=False),
        sa.Column('full_name', sa.String(length=255), nullable=False),
        sa.Column('hashed_password', sa.String(length=255), nullable=False),
        sa.Column('role', user_role_enum, nullable=False, server_default='USER'),
        sa.Column('is_active', sa.Boolean(), nullable=True, server_default='true'),
        sa.Column('created_at', sa.DateTime(), nullable=True, server_default=sa.text('now()')),
        sa.PrimaryKeyConstraint('id')
    )

    # 3. Create indexes for fast lookup
    op.create_index(op.f('ix_users_email'), 'users', ['email'], unique=True)
    op.create_index(op.f('ix_users_id'), 'users', ['id'], unique=False)

    # 4. Add user_id Foreign Key to 'requests' table
    with op.batch_alter_table('requests') as batch_op:
        batch_op.add_column(sa.Column('user_id', sa.Integer(), nullable=True))
        batch_op.create_foreign_key('fk_requests_user_id_users', 'users', ['user_id'], ['id'], ondelete='CASCADE')


def downgrade() -> None:
    """
    Downgrade schema: Drop foreign key, users table, and userrole ENUM.
    """
    with op.batch_alter_table('requests') as batch_op:
        batch_op.drop_constraint('fk_requests_user_id_users', type_='foreignkey')
        batch_op.drop_column('user_id')

    op.drop_index(op.f('ix_users_id'), table_name='users')
    op.drop_index(op.f('ix_users_email'), table_name='users')
    op.drop_table('users')
    user_role_enum.drop(op.get_bind(), checkfirst=True)


