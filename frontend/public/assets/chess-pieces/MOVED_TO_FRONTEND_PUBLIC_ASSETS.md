This submodule has been moved to `frontend/public/assets/chess-pieces`.

Keep the submodule configuration in `.gitmodules`. If you need to reinitialize the submodule at the new path run:

    git submodule sync
    git submodule update --init --recursive

If you prefer the submodule to live only at the new path, remove the old directory and re-add the submodule at the new path.
